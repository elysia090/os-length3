import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {deployedCode} from '../deployed-code.ts';

const wasm = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0);
const stored = new Uint8Array(gzipSync(wasm));
const sha256 = createHash('sha256').update(stored).digest('hex');
const programs = new Map([['origin', {program: {path: '/bin/app', sha256,
  wasm: {path: `blobs/${sha256}.bin`, sha256, size: stored.length, bytes: wasm.length}}}]]);

test('a deployed module is read once for concurrent execs and retains its integrity error', async t => {
  const read = t.mock.method(globalThis, 'fetch', async () => new Response(stored));
  let wake = Promise.withResolvers<void>();
  const reader = deployedCode(programs, 'https://ricebox.test/', false, () => wake.resolve(), () => ({release() {}}));
  t.after(() => reader.close());
  assert.equal(reader.has('overlay'), false);
  assert.equal(reader.take('origin'), undefined);
  assert.equal(reader.take('origin'), undefined);
  assert.equal(reader.reading(), 1);
  await wake.promise;
  assert.equal(read.mock.callCount(), 1);
  assert.ok(reader.take('origin')?.module instanceof WebAssembly.Module);
  assert.equal(reader.reading(), 0);

  wake = Promise.withResolvers<void>();
  read.mock.mockImplementation(async () => new Response(stored.map(byte => byte ^ 1)));
  assert.equal(reader.take('origin'), undefined);
  await wake.promise;
  assert.equal(reader.has('origin'), true);
  assert.throws(() => reader.take('origin'), /could not load deployed Wasm for \/bin\/app/);
});

test('retirement aborts an in-flight deployment read and suppresses delivery', async t => {
  const fetching = Promise.withResolvers<void>(), drained = Promise.withResolvers<void>();
  t.mock.method(globalThis, 'fetch', async (_url: URL, init: RequestInit) => {
    fetching.resolve();
    return await new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), {once: true});
    });
  });
  const notify = t.mock.fn();
  const reader = deployedCode(programs, 'https://ricebox.test/', false, notify, () => ({release: drained.resolve}));
  assert.equal(reader.take('origin'), undefined);
  await fetching.promise;
  reader.close();
  await drained.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(reader.reading(), 0);
  assert.equal(reader.has('origin'), false);
  assert.equal(notify.mock.callCount(), 0);
});
