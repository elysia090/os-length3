#!/usr/bin/env node
// Build the installable JS boundary from the existing implementation. The package
// carries the complete relative module closure, never why or a second runtime.
// No downloads, install hook, credentials, or publication. Supply a NEW output path.
// node module/ricebox/make/npm.mjs OUT
import {stripTypeScriptTypes} from 'node:module';
import {readFileSync, mkdirSync, writeFileSync, existsSync} from 'node:fs';
import {resolve, join, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const out = process.argv[2] && resolve(process.argv[2]);
if (!out) throw new Error('usage: node module/ricebox/make/npm.mjs OUT');
if (existsSync(out)) throw new Error(`Refusing to replace an existing directory: ${out}`);
const entry = 'module/ricebox/layers/root.ts';
const closure = new Map();
function visit(path) {
  if (closure.has(path)) return;
  if (!/^module\/(ricebox\/layers|sods\/runtime)\//.test(path) || !path.endsWith('.ts')) {
    throw new Error(`Unexpected dependency outside ricebox and sods: ${path}`);
  }
  const source = readFileSync(join(repository, path), 'utf8');
  // Keep type-only dependencies too: the original sources are the types entry.
  // Emitted JavaScript needs no TypeScript loader in the consumer.
  const javascript = stripTypeScriptTypes(source, {mode: 'transform'});
  closure.set(path, {source, javascript});
  for (const match of source.matchAll(/['"](\.[^'"\n]+\.ts)['"]/g)) {
    const dependency = relative(repository, resolve(repository, dirname(path), match[1]));
    visit(dependency);
  }
}
visit(entry);
mkdirSync(out, {recursive: true});
for (const [path, {source, javascript}] of closure) {
  const destination = join(out, path);
  mkdirSync(dirname(destination), {recursive: true});
  writeFileSync(destination, source);
  writeFileSync(destination.slice(0, -3) + '.js', javascript.replace(/(['"])(\.[^'"\n]+)\.ts\1/g, '$1$2.js$1'));
}
mkdirSync(join(out, 'module/ricebox/npm'), {recursive: true});
writeFileSync(join(out, 'module/ricebox/npm/vite.mjs'), readFileSync(join(repository, 'module/ricebox/npm/vite.mjs'), 'utf8').replace("'../layers/table.ts'", "'../layers/table.js'"));
writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: 'ricebox', version: '0.0.1', private: true, type: 'module',
  description: 'The product-independent ricebox distribution loader',
  exports: {'.': {types: './' + entry, import: './' + entry.replace(/\.ts$/, '.js')}, './vite': './module/ricebox/npm/vite.mjs'},
  engines: {node: '>=22.18'},
}, null, 2) + '\n');
writeFileSync(join(out, 'README.md'), `# ricebox\n\nThis local package exposes the existing createRoot and Box contracts without why.\nIt carries ricebox and sods JavaScript, including their Worker entry points.\nServe the distribution's layers separately and give createRoot its base URL.\nA bundler with module-Worker support is required for browser applications.\nThis package does not select/build packages, persist user data, or deploy a service.\nIt does not claim Cloudflare isolate execution merely because its files can be served there.\nThe package is private while the complete public installation flow is being verified.\n`);
console.log(`ricebox: ${closure.size} modules, no product dependencies; npm pack ${out}`);
