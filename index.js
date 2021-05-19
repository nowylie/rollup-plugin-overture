import { readFile } from 'fs/promises';
import { parse, parseExpressionAt } from 'acorn';
import { generate } from 'astring';
import e from 'estree-builder';
import raw from 'rehype-raw';
import markdown from 'remark-parse';
import remark2rehype from 'remark-rehype';
import unified from 'unified';
import { htmlTagNames } from 'html-tag-names';

import { visit } from 'unist-util-visit';

const standardTags = new Set(htmlTagNames);

function findExpression(str) {
    let openBraces = 0, start = 0;
    for (let pos = 0; pos < str.length; pos++) {
        if (str[pos] === '{') {
            if (openBraces === 0) {
                start = pos;
            }
            openBraces++;
        }
        if (str[pos] === '}') {
            openBraces--;
            if (openBraces === 0) {
                return { start, end: pos };
            }
        }
    }
    return null;
}

function handleExpressions(value) {
    const pos = findExpression(value);
    if (pos) {
        const parts = [];
        if (pos.start > 0) {
            parts.push(e.str(value.slice(0, pos.start)));
        }

        parts.push(parseExpressionAt(value.slice(pos.start+1, pos.end), 0, { ecmaVersion: 'latest' }));

        if (pos.end+1 < value.length) {
            parts.push(e.str(value.slice(pos.end+1)));
        }
        return parts
    }
    return e.str(value);
}

function parseProperties(node) {
    return Object.entries(node.properties)
        .reduce((properties, [key, value]) => {
            // Something funky happens to class names...
            if (key === 'className' && Array.isArray(value)) {
                value = value.join(' ');
            }
            value = handleExpressions(value);
            if (Array.isArray(value)) {
                properties[key] = e.call(
                    e('.', e.arr(value), e.id('join')),
                    [e.str('')],
                );
            } else {
                properties[key] = value;
            }
            return properties;
        }, {})
}

const handlers = {
    root(_, children) {
        return e('default-export',
            e.fn(['ctx'], [
                e.return(
                    e.arr(children),
                ),
            ], 'draw'),
        );
    },
    element(node, children) {
        if (node.tagName === 'script') {
            throw new Error('Nested <script> tags are not supported!')
        }
        const properties = parseProperties(node);
        return e.call(
            e.id('el'),
            [
                e.str(node.tagName),
                e.obj(properties),
                e.arr(children),
            ],
        );
    },
    text(node) {
        return handleExpressions(node.value);
    },
    view(node) {
        const properties = parseProperties(node);
        return e.new(
            e.id(node.tagName),
            [e.obj(properties)],
        );
    }
};

function toDraw(node) {
    if (handlers.hasOwnProperty(node.type)) {
        if (node.hasOwnProperty('children')) {
            const children = node.children
                // Filter out empty lines
                .filter(child => child.type !== 'text' || child.value !== '\n')
                .flatMap(child => toDraw(child));
            node = handlers[node.type](node, children);
            return node;
        }
        return handlers[node.type](node);
    }
    return null;
}


export default function rollupPluginOverture() {
    return {
        name: 'rollup-plugin-overture',

        // Load this plugin before Vite plugins
        enforce: 'pre',

        async load(id) {
            if (!id.endsWith('.md')) {
                return null;
            }

            const src = await readFile(id, { encoding: 'utf8' });

            // Parse the markdown source into MAST
            const mast = unified().use(markdown).parse(src);

            // Transpile from markdown to HTML
            let hast = await unified().use(remark2rehype, { allowDangerousHtml: true }).run(mast);

            // The markdown parser doesn't parse HTML inside the original
            // markdown so we need to revisit any unparsed nodes in the
            // new HTML AST and parse them.
            hast = await unified().use(raw).run(hast);

            const module = {
                type: 'Program',
                body: [],
            };

            // Extract <script> tags and parse them
            hast.children = hast.children.filter(element => {
                if (element.tagName === 'script') {
                    const { type = 'script' } = element.properties;
                    element.children.forEach(script => parse(script.value, {
                        ecmaVersion: 'latest',
                        sourceType: type,
                        program: module,
                    }));
                    return false;
                }
                return true;
            });

            // Add { el } import from the 'overture/dom' module
            // FIXME: This needs some serious cleanup
            const hasOvertureDomImport = module.body.find(node => {
                if (node.type === 'ImportDeclaration' && node.source.value === 'overture/dom') {
                    const hasElImport = node.specifiers.find(s => s.type === 'ImportSpecifier' && s.imported.name === 'el');
                    if (!hasElImport) {
                        node.specifiers.push(e('named-import', e.id('el')))
                    }
                    return true;
                }
                return false;
            })
            if (!hasOvertureDomImport) {
                module.body.unshift(
                    e.import([
                        e('named-import', e.id('el')),
                    ], e.str('overture/dom')),
                );
            }

            // Collect import identifiers that look like Overture View classes
            // so that we can use them to try and identify Views in the HTML
            const imports = new Map;
            module.body.forEach(node => {
                if (node.type !== 'ImportDeclaration') {
                    return;
                }
                node.specifiers.forEach(specifier => {
                    const name = specifier.local.name;
                    if (/^[A-Z]/.test(name)) {
                        imports.set(name.toLowerCase(), name);
                    }
                })
            })

            // Find non-standard elements. If they map to imported symbols
            // assume they are Overture View classes and modify the AST nodes
            visit(hast, 'element', node => {
                if (standardTags.has(node.tagName)) {
                    return;
                }
                const klass = imports.get(node.tagName);
                if (!klass) {
                    return;
                }
                node.type = 'view',
                node.tagName = klass;
            });

            // Transpile HTML into an Overture draw() function
            const draw = toDraw(hast);
            module.body.push(
                draw,
            )

            // Stringify module
            const code = generate(module);

            return code;
        }
    }
}