import assert from 'node:assert/strict';
import {test} from 'node:test';
import {builtin, canRunApart, isNode, isShared, mayWait, nodeThreads, processors, said} from '../../../sods/runtime/host.ts';

// The host as sods answers for it (sods/runtime/host.ts), here where the host is node: what the runtime asks in place
// of looking for itself.
test('node is known for node: its threads, its own modules, what was said to it', async () => {
  assert.equal(isNode, true);
  assert.equal(typeof (await nodeThreads())?.Worker, 'function');
  assert.equal(typeof builtin<typeof import('node:os')>('os')?.totalmem, 'function');
  assert.equal(builtin('no-such-module'), null);
  process.env.SODS_HOST_TEST = 'said';
  assert.equal(said('SODS_HOST_TEST'), 'said');
  process.env.SODS_HOST_TEST = '';
  assert.equal(said('SODS_HOST_TEST'), undefined, 'said empty is not said');
  delete process.env.SODS_HOST_TEST;
  assert.equal(said('SODS_HOST_TEST'), undefined);
});

test('memory shared between threads is told from memory that is not, and threads run apart and wait here', () => {
  assert.equal(isShared(new SharedArrayBuffer(8)), true);
  assert.equal(isShared(new ArrayBuffer(8)), false);
  assert.equal(isShared(new WebAssembly.Memory({initial: 1, maximum: 1, shared: true}).buffer), true);
  assert.equal(canRunApart(), true);
  assert.equal(mayWait, true);
  const n = processors();
  assert.ok(Number.isInteger(n) && n >= 1 && n <= 64, String(n));
});
