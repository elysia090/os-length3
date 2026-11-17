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
  for (const target of ['../../../why/api/host.ts', '../../../shipto/client.ts', '../build/distribution.ts', './test/helper.ts', '../../otter/make/artifacts.mjs', '../../sods/runtime/linux/process.ts', 'node:fs', 'why', 'https://example.com/code.js']) {
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
  for (const target of ['../runtime/root-types.ts','../runtime/root.ts','../build/distribution.ts','../../sods/runtime/linux.ts','node:fs']) assert.equal(allowed(format,target),false,target);
  assert.equal(allowed('module/ricebox/runtime/root.ts','../distribution/manifest.ts'),true);
  assert.equal(allowed('module/ricebox/distribution/mount.ts','./pack.ts'),true);
});

test('deployment is independent of composition and integrations',()=>{
  const assets='module/ricebox/deployment/assets.ts';
  for(const target of ['../build/prepare.ts','../integrations/vite.ts','../runtime/root.ts','../../sods/runtime/linux.ts','node:child_process']) assert.equal(allowed(assets,target),false,target);
  assert.equal(allowed(assets,'../distribution/manifest.ts'),true);
  assert.equal(allowed(assets,'node:fs'),true);
  assert.equal(allowed('module/ricebox/integrations/vite.ts','../deployment/assets.ts'),true);
  assert.equal(allowed('module/ricebox/integrations/vite.ts','../build/prepare.ts'),true);
  assert.equal(allowed('module/ricebox/build/prepare.ts','../integrations/vite.ts'),false);
  assert.equal(allowed('module/ricebox/runtime/root.ts','../deployment/assets.ts'),false);
});

test('Node readers cannot depend on execution or deployment orchestration',()=>{
  const reader='module/ricebox/host/node/tar.ts';
  for(const target of ['../../runtime/root.ts','../../deployment/local.ts','../../build/prepare.ts','../../../sods/runtime/linux.ts']) assert.equal(allowed(reader,target),false,target);
  assert.equal(allowed(reader,'../../distribution/inventory.ts'),true);
  assert.equal(allowed('module/ricebox/deployment/local.ts','../host/node/hash.ts'),true);
  assert.equal(allowed('module/ricebox/distribution/inventory.ts','../host/node/hash.ts'),false);
});


test('verification consumes production contracts without becoming a production dependency',()=>{
  const programs='module/ricebox/verification/programs.ts';
  for(const target of ['../runtime/prepared-tree.ts','../deployment/local.ts','../build/muk-artifact.ts','../../sods/runtime/linux.ts','node:child_process']) assert.equal(allowed(programs,target),true,target);
  for(const target of ['../build/distribution.ts','../../sods/runtime/linux/kernel.ts','../../../why/api/host.ts','node:net']) assert.equal(allowed(programs,target),false,target);
  for(const from of ['runtime/root.ts','distribution/manifest.ts','deployment/local.ts','build/prepare.ts','integrations/vite.ts']) assert.equal(allowed('module/ricebox/'+from,'../verification/programs.ts'),false,from);
  assert.equal(allowed('module/ricebox/verification/language-cases.ts','node:child_process'),false);
});


test('build artifact validation uses only the public sods entry and compression is host-specific',()=>{
  assert.equal(allowed('module/ricebox/build/file-store-artifact.ts','../../sods/runtime/linux.ts'),true);
  assert.equal(allowed('module/ricebox/build/file-store-artifact.ts','../../sods/runtime/file-store.ts'),false);
  assert.equal(allowed('module/ricebox/build/prepare.ts','../../sods/runtime/linux.ts'),false);
  assert.equal(allowed('module/ricebox/build/compress.worker.ts','node:zlib'),true);
  assert.equal(allowed('module/ricebox/build/compress.worker.ts','node:fs'),false);
  assert.deepEqual(violations({'module/ricebox/build/compression-pool.ts':"new Worker(new URL('./compress.worker.ts', import.meta.url))"}),[]);
});
