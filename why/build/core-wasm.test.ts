import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test} from 'node:test';
import {BROWSER_INPUTS} from '../test/app/build-inputs.ts';
import {CORE_INPUTS} from './core-wasm.ts';

for (const changed of ['.cargo/config.toml', 'ricebox/distribution/build.rs']) {
  test(`the browser core does not reuse a module older than ${changed}`, t => {
    const tree = mkdtempSync(join(tmpdir(), 'why-core-inputs-'));
    t.after(() => rmSync(tree, {recursive: true, force: true}));
    const script = join(tree, 'why/build/core-wasm.ts');
    const wasm = join(tree, 'target/wasm32-wasip1/web/why_core_web.wasm');
    mkdirSync(dirname(script), {recursive: true});
    mkdirSync(dirname(wasm), {recursive: true});
    copyFileSync(new URL('./core-wasm.ts', import.meta.url), script);
    writeFileSync(wasm, 'previous module');
    utimesSync(wasm, 1000, 1000);
    const source = join(tree, changed);
    mkdirSync(dirname(source), {recursive: true});
    writeFileSync(source, 'changed build input');
    utimesSync(source, 2000, 2000);
    const run = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {buildCoreWasm} from './why/build/core-wasm.ts'; buildCoreWasm();`],
    {cwd: tree, encoding: 'utf8', env: {...process.env, PATH: '', CARGO_TARGET_DIR: ''}});
    assert.notEqual(run.status, 0, 'stale module must not be accepted');
    assert.match(run.stderr, /needs Rust to build/);
  });
}

test('selftest build invalidation includes the core and browser build dependency layers', () => {
  const covers = (file: string) => BROWSER_INPUTS.some(input => file === input || file.startsWith(`${input}/`));
  for (const input of [...CORE_INPUTS, 'why/build/boot.ts', 'why/app/vite.config.ts',
    'ricebox/distribution/format/manifest.ts', 'ricebox/distribution/format/pack.ts',
    'ricebox/distribution/build/muk-artifact.ts', 'ricebox/muk/src/muk.c',
    'ricebox/toolchain/build.sh', 'wrangler.toml']) assert.ok(covers(input), input);
});
