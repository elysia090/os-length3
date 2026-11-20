// A clean consumer uses the package's actual JavaScript exports, not a workspace alias.
// The .mts app is typechecked here against that fresh npm installation.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync, mkdirSync, realpathSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const output = process.argv[2] && resolve(process.argv[2]);
if (!output) throw new Error('usage: stage-consumer.mjs NEW_WORK_DIR');
mkdirSync(output);
const repo = fileURLToPath(new URL('../../../../../', import.meta.url));
const packageRoot = join(output, 'package'), consumer = join(output, 'consumer');
const node = (args, cwd = repo) => execFileSync(process.execPath, args, {cwd, stdio: 'inherit', timeout: 45_000});
node([join(repo, 'ricebox/distribution/build/npm.ts'), packageRoot]);
const npm = (args, cwd) => execFileSync('npm', args, {
  cwd, encoding: 'utf8', timeout: 45_000, env: {...process.env, npm_config_cache: join(output, 'npm-cache')},
});
const packed = JSON.parse(npm(['pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', output], packageRoot));
assert.equal(packed.length, 1);
mkdirSync(consumer);
writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(output, packed[0].filename)], consumer);
const installed = realpathSync(join(consumer, 'node_modules/ricebox/ricebox'));
node(['--no-experimental-strip-types', '--input-type=module', '-e', [
  "import assert from 'node:assert/strict';",
  "import {createRoot, retireRootWorker} from 'ricebox';",
  "import {mountGuestSurface, surfaceFromMirror} from 'ricebox/everyday';",
  "for (const api of [createRoot, retireRootWorker, mountGuestSurface, surfaceFromMirror]) assert.equal(typeof api,'function');",
  "assert.equal(import.meta.resolve('ricebox')," + JSON.stringify(pathToFileURL(join(installed, 'distribution/runtime/root.js')).href) + ");",
  "assert.equal(import.meta.resolve('ricebox/everyday')," + JSON.stringify(pathToFileURL(join(installed, 'everyday/src/surface.js')).href) + ");",
].join('\n')], consumer);

for (const dir of ['browser', 'support']) mkdirSync(join(consumer, dir));
for (const name of ['index.html', 'demo.mts', 'shell-page.mts', 'camera-placement.mts', 'raster-fixture.ts', 'shell-fixture.ts', 'guest-pair.integration.mjs']) {
  copyFileSync(new URL(name, import.meta.url), join(consumer, 'browser', name));
}
copyFileSync(new URL('../support/mirror-raster.ts', import.meta.url), join(consumer, 'support/mirror-raster.ts'));
node([join(repo, 'node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck',
  '--allowImportingTsExtensions', '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
  '--lib', 'ES2024,DOM,DOM.Iterable', '--types', 'node', '--typeRoots', join(repo, 'node_modules/@types'),
  'browser/demo.mts'], consumer);
console.log('Installed Ricebox JS imports and consumer typecheck passed.');
