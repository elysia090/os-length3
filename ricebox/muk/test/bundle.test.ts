// OCI's rlimits is a set of resource types, not an ordered list of changes to apply.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {asks, Refused} from './asks.ts';

const limit = (type: string, hard = 1024) => ({type, soft: 1024, hard});
const config = (rlimits?: ReturnType<typeof limit>[]) => new TextEncoder().encode(JSON.stringify({
  ociVersion: '1.2.0',
  process: {args: ['/program'], cwd: '/', rlimits},
  root: {path: 'rootfs'},
  linux: {namespaces: ['mount', 'pid', 'ipc', 'uts', 'network'].map((type) => ({type}))},
}));

test('a bundle refuses duplicate rlimit types, even when their values agree', () => {
  for (const limits of [
    [limit('RLIMIT_NOFILE'), limit('RLIMIT_NOFILE')],
    [limit('RLIMIT_NOFILE'), limit('RLIMIT_NOFILE', 2048)],
    [limit('RLIMIT_NOFILE'), limit('RLIMIT_CORE'), limit('RLIMIT_NOFILE')],
  ]) {
    assert.throws(() => asks(config(limits)), {
      constructor: Refused,
      message: 'config.json: process.rlimits: one kind is there twice',
    });
  }
});

test('a bundle keeps distinct rlimits and permits no limits', () => {
  assert.deepEqual(asks(config()).limits, []);
  assert.deepEqual(asks(config([])).limits, []);
  assert.deepEqual(asks(config([limit('RLIMIT_NOFILE'), limit('RLIMIT_CORE', 2048)])).limits, [
    {what: 7, now: 1024n, most: 1024n},
    {what: 4, now: 1024n, most: 2048n},
  ]);
});


test('a rejected bundle in shared memory still gives the OCI error, rather than a host decoding error', () => {
  const text = config([limit('RLIMIT_NOFILE'), limit('RLIMIT_NOFILE')]);
  const shared = new Uint8Array(new SharedArrayBuffer(text.length));
  shared.set(text);
  assert.throws(() => asks(shared), {constructor: Refused, message: 'config.json: process.rlimits: one kind is there twice'});
});
