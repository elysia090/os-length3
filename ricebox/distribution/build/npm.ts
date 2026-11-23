#!/usr/bin/env node
// Build the installable JS boundary from the existing implementation. The package
// carries the complete relative module closure, never why or a second runtime.
// Build the default guest from the package cache once, before npm pack.
// node ricebox/distribution/build/npm.ts OUT [--package-cache CACHE | --runtime-only]
import {packageBrowserManifest, packageTypeScript} from '../../toolchain/package-typescript.ts';
import {lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {sha256} from '../host/node/hash.ts';
import {prepareDistribution} from './prepare.ts';
import {releaseVersion} from './version.ts';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const version = releaseVersion();
const entry = 'ricebox/distribution/runtime/root.ts';
const display = 'ricebox/everyday/src/surface.ts';
const assets = 'ricebox/distribution/deployment/assets.ts';

function buildPackage(out: string, bundled: boolean) {
  const modules = packageTypeScript(repository, out, [
    entry, display, assets, 'ricebox/distribution/integrations/vite.ts', 'ricebox/distribution/build/prepare.ts',
    'ricebox/distribution/starter/stage.ts', 'ricebox/distribution/starter/shell.ts',
    // CLI roots invoked by prepare.ts and assemble.sh, not static imports.
    'ricebox/distribution/build/distribution.ts', 'ricebox/distribution/build/package-database.ts',
    'ricebox/distribution/build/script-interpreters.ts',
  ], path => {
    if (!/^ricebox\/(distribution\/(?:runtime|format|build|deployment|integrations|starter|host\/node)|sods\/runtime|everyday\/(?:src|terminal))\//.test(path) || !path.endsWith('.ts') || /\/(?:test|verification|site|demos?|examples?|playground)\/|\.(?:test|spec)\.ts$/.test(path)) {
      throw new Error(`Unexpected dependency outside ricebox and sods: ${path}`);
    }
  });
  packageBrowserManifest(out, entry, display);
  // Shell and data inputs are not TypeScript graph edges.
  for (const path of ['RELEASE', 'build/assemble.sh', 'etc/os-release', 'pins/sources.env', 'starter/index.html', 'starter/shell.css']) {
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
    bin: {'ricebox-stage-shell': './ricebox/distribution/starter/stage.js'},
    engines: {node: '>=22.18'},
  }, null, 2) + '\n');
  const starter = bundled
    ? 'The default Ricebox root is included. Run npm --prefix . exec --offline -- ricebox-stage-shell --preview and open the printed URL.'
    : 'To run the starter, supply ricebox.json with the location and trusted webroot.json and muk.json pins of your prepared Ricebox root.';
  writeFileSync(join(out, 'README.md'), `# ricebox

This local package exposes the existing createRoot and Box contracts without why.
It carries ricebox and sods JavaScript, including their Worker entry points.
${starter}
Run ricebox-stage-shell --help for the declaration format and static output options.

The staged site includes everyday.js, the browser entry for the same presenter
exported as ricebox/everyday. It presents frames supplied by the embedding page.

Use ricebox/assets from Node to verify and stage the distribution's static files.
Serve those files and give createRoot their URL prefix (for the default layout, /ricebox/).
For plain HTML, use browserModules() to stage native ES modules. Use
browserModules({display: true}) to include the presenter modules. You can also
use a bundler with module-Worker support.

Vite and ricebox/prepare compose prebuilt packages from a supplied cache. They
default to the Ricebox userland. Supply packages to replace that selection.
For a pinned catalog, acquire with otter first and pass its packages, packageCache
and tools. Composition requires Linux shell tools, GNU tar and zstd plus
integrity-pinned tools or the source toolchain.

The package is private while public installation is being verified.
`);
  return modules;
}

const {positionals, values} = parseArgs({allowPositionals: true, options: {
  'package-cache': {type: 'string'}, 'runtime-only': {type: 'boolean'},
}});
const requestedCache = values['package-cache'];
if (positionals.length !== 1 || requestedCache === '' || (values['runtime-only'] && requestedCache !== undefined)) {
  throw new Error('usage: node ricebox/distribution/build/npm.ts OUT [--package-cache CACHE | --runtime-only]');
}
const packageCache = values['runtime-only'] ? undefined : requestedCache ?? join(repository, 'target/root-packages');
const destination = resolve(positionals[0]!);
const requireNewDestination = () => {
  if (lstatSync(destination, {throwIfNoEntry: false})) throw new Error(`Refusing to replace an existing directory: ${destination}`);
};
requireNewDestination();
mkdirSync(dirname(destination), {recursive: true});
const scratch = mkdtempSync(join(dirname(destination), '.ricebox-npm-'));
const out = join(scratch, 'package');
try {
  if (packageCache) {
    const starter = join(out, 'ricebox/distribution/starter/default');
    const prepared = await prepareDistribution({packageCache, toolchain: repository, output: join(starter, 'prepared')});
    const guest = {
      webrootSha256: sha256(readFileSync(join(prepared, 'webroot.json'))),
      mukSha256: sha256(readFileSync(join(prepared, 'muk.json'))),
    };
    writeFileSync(join(starter, 'ricebox.json'), JSON.stringify({guest}, null, 2) + '\n');
  }
  const modules = buildPackage(out, !!packageCache);
  requireNewDestination();
  renameSync(out, destination);
  console.log(`ricebox: ${modules} modules${packageCache ? ' and standalone guest' : ''}; npm pack ${destination}`);
} finally {
  rmSync(scratch, {recursive: true, force: true});
}
