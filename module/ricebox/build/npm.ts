#!/usr/bin/env node
// Build the installable JS boundary from the existing implementation. The package
// carries the complete relative module closure, never why or a second runtime.
// No downloads, install hook, credentials, or publication. Supply a NEW output path.
// node module/ricebox/build/npm.ts OUT
import {stripTypeScriptTypes} from 'node:module';
import {readFileSync, mkdirSync, writeFileSync, existsSync} from 'node:fs';
import {resolve, join, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

// Node 24 supports transform; older @types/node describes only strip mode.
const transform = stripTypeScriptTypes as (source: string, options: {mode: 'strip' | 'transform'}) => string;
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const out = process.argv[2] && resolve(process.argv[2]);
if (!out) throw new Error('usage: node module/ricebox/build/npm.ts OUT');
if (existsSync(out)) throw new Error(`Refusing to replace an existing directory: ${out}`);
const entry = 'module/ricebox/runtime/root.ts';
const closure = new Map<string, {source: string; javascript: string}>();
function visit(path: string): void {
  if (closure.has(path)) return;
  if (!/^module\/(ricebox\/(?:runtime|distribution|build|deployment|integrations|host\/node)|sods\/runtime)\//.test(path) || !path.endsWith('.ts') || /\/(?:test|verification)\/|\.(?:test|spec)\.ts$/.test(path)) {
    throw new Error(`Unexpected dependency outside ricebox and sods: ${path}`);
  }
  const source = readFileSync(join(repository, path), 'utf8');
  // Keep type-only dependencies too: the original sources are the types entry.
  // Emitted JavaScript needs no TypeScript loader in the consumer.
  const javascript = transform(source, {mode: 'transform'});
  closure.set(path, {source, javascript});
  for (const match of source.matchAll(/['"](\.[^'"\n]+\.ts)['"]/g)) {
    const dependency = relative(repository, resolve(repository, dirname(path), match[1]));
    visit(dependency);
  }
}
visit(entry);
visit('module/ricebox/integrations/vite.ts');
visit('module/ricebox/build/prepare.ts');
// CLI roots invoked by prepare.ts and assemble.sh, not static imports. Their
// TypeScript dependencies use the same closure traversal as the public entries.
visit('module/ricebox/build/distribution.ts');
visit('module/ricebox/build/package-database.ts');
visit('module/ricebox/build/script-interpreters.ts');
mkdirSync(out, {recursive: true});
for (const [path, {source, javascript}] of closure) {
  const destination = join(out, path);
  mkdirSync(dirname(destination), {recursive: true});
  writeFileSync(destination, source);
  writeFileSync(destination.slice(0, -3) + '.js', javascript.replace(/(['"])(\.[^'"\n]+)\.ts\1/g, '$1$2.js$1'));
}
// Shell and data inputs are not TypeScript graph edges.
for (const path of ['build/assemble.sh', 'etc/os-release', 'pins/sources.env']) {
  const name = 'module/ricebox/' + path;
  mkdirSync(dirname(join(out, name)), {recursive: true});
  writeFileSync(join(out, name), readFileSync(join(repository, name)));
}
writeFileSync(join(out, 'module/sods/Cargo.toml'), readFileSync(join(repository, 'module/sods/Cargo.toml')));
writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: 'ricebox', version: '0.0.1', private: true, type: 'module',
  description: 'The product-independent ricebox distribution loader',
  exports: {'.': {types: './' + entry, import: './' + entry.replace(/\.ts$/, '.js')}, './vite': {types: './module/ricebox/integrations/vite.ts', import: './module/ricebox/integrations/vite.js'}, './prepare': {types: './module/ricebox/build/prepare.ts', import: './module/ricebox/build/prepare.js'}},
  engines: {node: '>=22.18'},
}, null, 2) + '\n');
writeFileSync(join(out, 'README.md'), `# ricebox\n\nThis local package exposes the existing createRoot and Box contracts without why.\nIt carries ricebox and sods JavaScript, including their Worker entry points.\nServe the distribution's layers separately and give createRoot its base URL.\nA bundler with module-Worker support is required for browser applications.\nThe Vite build option composes explicitly selected prebuilt packages through the existing assemble and AOT toolchain. Supply selected packages and a package cache. For a pinned catalog, acquire with otter first and pass its packages/packageCache/tools result; ricebox never fetches or resolves a catalog. Supply integrity-pinned translator, sods and muk artifacts as tools, and an optional matching file-store artifact as fileStore to use the bundled assembler and AOT scripts without building Rust/C; a source toolchain remains available for development. It also requires Linux shell tools, GNU tar and zstd; it does not install native build prerequisites. Catalog acquisition is owned by otter, not a second ricebox registry. It does not persist user data or deploy a service.\nIt does not claim Cloudflare isolate execution merely because its files can be served there.\nThe package is private while the complete public installation flow is being verified.\n`);
console.log(`ricebox: ${closure.size} modules, no product dependencies; npm pack ${out}`);
