#!/usr/bin/env node
// Build the installable JS boundary from the existing implementation. The package
// carries the complete relative module closure, never why or a second runtime.
// No downloads, install hook, credentials, or publication. Supply a NEW output path.
// node ricebox/distribution/build/npm.ts OUT
import {packageBrowserManifest, packageTypeScript} from '../../toolchain/package-typescript.ts';
import {readFileSync, mkdirSync, writeFileSync, existsSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {releaseVersion} from './version.ts';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const out = process.argv[2] && resolve(process.argv[2]);
if (!out) throw new Error('usage: node ricebox/distribution/build/npm.ts OUT');
if (existsSync(out)) throw new Error(`Refusing to replace an existing directory: ${out}`);
const version = releaseVersion();
const entry = 'ricebox/distribution/runtime/root.ts';
const display = 'ricebox/everyday/src/surface.ts';
const assets = 'ricebox/distribution/deployment/assets.ts';
const modules = packageTypeScript(repository, out, [
  entry, display, assets, 'ricebox/distribution/integrations/vite.ts', 'ricebox/distribution/build/prepare.ts',
  // CLI roots invoked by prepare.ts and assemble.sh, not static imports.
  'ricebox/distribution/build/distribution.ts', 'ricebox/distribution/build/package-database.ts',
  'ricebox/distribution/build/script-interpreters.ts',
], path => {
  if (!/^ricebox\/(distribution\/(?:runtime|format|build|deployment|integrations|host\/node)|sods\/runtime|everyday\/src)\//.test(path) || !path.endsWith('.ts') || /\/(?:test|verification|site|demos?|examples?|playground)\/|\.(?:test|spec)\.ts$/.test(path)) {
    throw new Error(`Unexpected dependency outside ricebox and sods: ${path}`);
  }
});
packageBrowserManifest(out, entry, display);
// Shell and data inputs are not TypeScript graph edges.
for (const path of ['RELEASE', 'build/assemble.sh', 'etc/os-release', 'pins/sources.env']) {
  const name = 'ricebox/distribution/' + path;
  mkdirSync(dirname(join(out, name)), {recursive: true});
  writeFileSync(join(out, name), readFileSync(join(repository, name)));
}
writeFileSync(join(out, 'ricebox/sods/Cargo.toml'), readFileSync(join(repository, 'ricebox/sods/Cargo.toml')));
writeFileSync(join(out, 'package.json'), JSON.stringify({
  name: 'ricebox', version, private: true, type: 'module',
  description: 'The product-independent ricebox distribution loader',
  exports: {
    '.': {types: './' + entry, import: './' + entry.replace(/\.ts$/, '.js')},
    './everyday': {types: './' + display, import: './' + display.replace(/\.ts$/, '.js')},
    './assets': {types: './' + assets, import: './' + assets.replace(/\.ts$/, '.js')},
    './vite': {types: './ricebox/distribution/integrations/vite.ts', import: './ricebox/distribution/integrations/vite.js'},
    './prepare': {types: './ricebox/distribution/build/prepare.ts', import: './ricebox/distribution/build/prepare.js'},
  },
  engines: {node: '>=22.18'},
}, null, 2) + '\n');
writeFileSync(join(out, 'README.md'), `# ricebox\n\nThis local package exposes the existing createRoot and Box contracts without why.\nIt carries ricebox and sods JavaScript, including their Worker entry points.\nThe optional ricebox/everyday entry presents explicitly supplied guest frames; it starts no Worker and mounts no default UI.\nUse ricebox/assets from Node to verify and stage the distribution's static files without the Vite adapter.\nServe those files separately and give createRoot their URL prefix (for the default layout, /ricebox/).\nFor plain HTML, use browserModules() from ricebox/assets to stage the built ES modules, then import ./ricebox-js/distribution/runtime/root.js. Use browserModules({display: true}) only if you also need the presenter modules. Alternatively use a bundler with module-Worker support.\nThe Vite build option composes explicitly selected prebuilt packages through the existing assemble and AOT toolchain. Supply selected packages and a package cache. For a pinned catalog, acquire with otter first and pass its packages/packageCache/tools result; ricebox never fetches or resolves a catalog. Supply integrity-pinned translator, sods and muk artifacts as tools to use the bundled assembler and AOT scripts without building Rust/C; a source toolchain remains available for development. It also requires Linux shell tools, GNU tar and zstd; it does not install native build prerequisites. Catalog acquisition is owned by otter, not a second ricebox registry. It does not persist user data or deploy a service.\nIt does not claim Cloudflare isolate execution merely because its files can be served there.\nThe package is private while the complete public installation flow is being verified.\n`);
console.log(`ricebox: ${modules} modules, no product dependencies; npm pack ${out}`);
