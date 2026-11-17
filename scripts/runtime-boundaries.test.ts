import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {ROOTS, allowed, references, runtimeSources, violations} from './runtime-boundaries.ts';

test('runtime module boundaries hold in the actual source tree', () => {
  const sources = runtimeSources(fileURLToPath(new URL('..', import.meta.url)));
  for (const root of ROOTS) assert.ok(Object.keys(sources).some(path => path.startsWith(root + '/')), `no runtime sources checked in ${root}`);
  assert.deepEqual(violations(sources), []);
  // Prove that this is checking repository content, not only the parser's synthetic examples.
  const file = 'module/ricebox/runtime/root.ts';
  assert.equal(typeof sources[file], 'string');
  assert.deepEqual(violations({...sources, [file]: sources[file] + '\nimport type {Product} from "../../../why/api/host.ts";'}),
    [file + ' -> ../../../why/api/host.ts']);
});

test('type imports, re-exports, dynamic imports and worker source URLs are dependencies', () => {
  assert.deepEqual(references(`
    import type {A} from './a.ts';
    export type {B} from './b.ts';
    import './side.ts';
    const c = import('./c.ts');
    type D = import('./d.ts').D;
    const worker = new Worker(new URL('./worker.ts', import.meta.url));
    // import './not-code.ts';
    /* export {X} from './also-not-code.ts'; */
    const words = "import './not-an-import.ts'";
    export function example(from: string) { return from; }
    export type Example = {from: string};
  `), ['./a.ts', './b.ts', './side.ts', './c.ts', './d.ts', './worker.ts']);
});

test('runtime cannot reach products, build tools, tests or private sods internals', () => {
  for (const target of ['../../../why/api/host.ts', '../../../shipto/client.ts', '../make/layers.ts', './test/helper.ts', '../../otter/make/artifacts.mjs', '../../sods/runtime/linux/process.ts', 'node:fs', 'why', 'https://example.com/code.js']) {
    assert.equal(allowed('module/ricebox/runtime/root.ts', target), false, target);
  }
  assert.equal(allowed('module/sods/runtime/linux.ts', '../../ricebox/runtime/root.ts'), false);
  assert.equal(allowed('module/sods/runtime/linux.ts', './run.ts'), false);
  assert.equal(allowed('module/disk/indexeddb.ts', '../sods/runtime/linux.ts'), false);
  assert.equal(allowed('module/cowboy/host/outside.ts', '../../sods/runtime/linux.ts'), true);
  assert.equal(allowed('module/ricebox/runtime/root.ts', '../../sods/runtime/translate.ts'), true);
});

test('computed imports cannot bypass the allowlist; Node facilities stay in the host adapter', () => {
  for (const source of ['import(name)', 'import("./a" + name)', 'import(`./${name}.ts`)', 'require(name)']) {
    assert.ok(violations({'module/ricebox/runtime/root.ts': source}).length, source);
  }
  assert.equal(allowed('module/sods/runtime/host.ts', 'node:worker_threads'), true);
  assert.equal(allowed('module/sods/runtime/linux.ts', 'node:worker_threads'), false);
  assert.equal(allowed('module/sods/runtime/host.ts', 'node:child_process'), false);
  assert.equal(allowed('module/sods/runtime/run.ts', 'node:child_process'), true);
});

test('bundler worker queries and computed worker sources cannot hide a forbidden dependency', () => {
  const from = 'module/ricebox/runtime/root.ts';
  for (const source of [
    "new Worker(new URL('../../../why/api/worker.ts?worker', import.meta.url))",
    "import Worker from '../../../why/api/worker.ts?worker'",
    "const entry = new URL('../../../why/api/worker.ts?url', import.meta.url)",
    'new Worker(entry)',
    'new SharedWorker(new URL(name, import.meta.url))',
    "import.meta.glob('../../../why/**/*.ts')",
    '`result: ${import("../../../why/api/host.ts")}`',
  ]) assert.ok(violations({[from]: source}).length, source);
  assert.deepEqual(violations({[from]: "new Worker(new URL('./worker.ts', import.meta.url))"}), []);
});

test('distribution format is below execution, without host or product capabilities', () => {
  const format='module/ricebox/distribution/manifest.ts';
  for (const target of ['../runtime/root-types.ts','../runtime/root.ts','../make/layers.ts','../../sods/runtime/linux.ts','node:fs']) assert.equal(allowed(format,target),false,target);
  assert.equal(allowed('module/ricebox/runtime/root.ts','../distribution/manifest.ts'),true);
  assert.equal(allowed('module/ricebox/distribution/mount.ts','./pack.ts'),true);
});
