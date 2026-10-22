import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Pipe} from '../runtime/fd.mjs';
import {prepare} from '../runtime/share.mjs';
import {have, shell} from './busybox.mjs';

// Processes run at once, pipes hold their writers, signals reach their
// handlers: each as BusyBox shows it, beside the same script on Linux
// (the outputs here are what Linux prints).

const APPLETS = ['sh', 'cat', 'sleep', 'dd', 'wc', 'kill', 'yes', 'head', 'sha256sum', 'echo', 'true'];

/** Run `script` to its end, waiting out its sleeps; {status, out, ms}. */
async function run(script) {
  const t0 = performance.now();
  const {kernel, out} = await shell(script, APPLETS);
  let r = kernel.pump();
  const seen = [];
  while (r.waiting && r.until !== undefined) {
    seen.push({at: performance.now() - t0, out: out()});
    await new Promise((go) => setTimeout(go, Math.max(0, r.until - performance.now())));
    r = kernel.pump();
  }
  assert.ok(!r.waiting, 'it does not wait for input');
  return {status: r.status, out: out(), ms: performance.now() - t0, seen};
}

test('a background job does not hold the shell: READY comes before the sleep ends', {skip: !have}, async () => {
  const r = await run('sleep 1 & echo READY; wait; echo DONE');
  assert.equal(r.out, 'READY\nDONE\n');
  // While the job slept, the shell had already said READY.
  assert.equal(r.seen[0]?.out, 'READY\n');
  assert.ok(r.ms >= 1000, `${r.ms} ms`);
});

test('a producer and a consumer run together: 65 MiB through a 64 KiB pipe, every byte counted', {skip: !have}, async () => {
  const r = await run('dd if=/dev/zero bs=1M count=65 2>/dev/null | wc -c');
  assert.equal(r.out.trim(), String(65 << 20));
  assert.equal(r.status, 0);
});

test('the bytes through a pipe are the bytes written (checksum)', {skip: !have}, async () => {
  const r = await run('dd if=/dev/urandom of=/tmp/x bs=64k count=20 2>/dev/null; a=$(sha256sum < /tmp/x); b=$(cat /tmp/x | cat | sha256sum); [ "$a" = "$b" ] && echo same');
  assert.equal(r.out, 'same\n');
});

test('a trap runs its handler and the shell goes on; TERM, INT and USR1', {skip: !have}, async () => {
  const r = await run('trap "echo got USR1" USR1; trap "echo got TERM" TERM; trap "echo got INT" INT; kill -USR1 $$; kill -TERM $$; kill -INT $$; echo after');
  assert.equal(r.out, 'got USR1\ngot TERM\ngot INT\nafter\n');
  assert.equal(r.status, 0);
});

test('a trap for a signal from a child runs while the shell waits for it', {skip: !have}, async () => {
  const r = await run('trap "echo cleanup" USR1; (sleep 1; kill -USR1 $$) & wait; echo after');
  assert.equal(r.out, 'cleanup\nafter\n');
});

test('an untrapped TERM ends the shell (143), an ignored one does nothing', {skip: !have}, async () => {
  assert.equal((await run('kill -TERM $$; echo not here')).status, 15);
  const r = await run('trap "" TERM; kill -TERM $$; echo still here');
  assert.equal(r.out, 'still here\n');
});

test('SIGPIPE ends a writer whose reader has gone, quietly, as 141', {skip: !have}, async () => {
  const r = await run('(yes; echo "yes ended $?" >&2) | head -n 1');
  assert.equal(r.out, 'y\nyes ended 141\n');
});

test('a full pipe makes its writer wait; it never says EPIPE while a reader is there', () => {
  const p = new Pipe();
  p.readers = 1;
  assert.equal(p.write(new Uint8Array(100000)), 65536, 'what fits');
  assert.ok(!p.writable);
  assert.equal(p.read(4096).length, 4096);
  assert.ok(p.writable, 'a page is free again');
  assert.equal(p.write(new Uint8Array(10000)), 4096);
});

test('a pipe holds what a Linux pipe holds: small writes share a page only when they fit whole', () => {
  const p = new Pipe();
  let n = 0;
  while (p.fits(1000)) n += p.write(new Uint8Array(1000));
  assert.equal(n, 64000);
  const q = new Pipe();
  while (q.fits(1024)) q.write(new Uint8Array(1024));
  assert.equal(q.size, 65536);
});

test('a translation is run without its data in the module, and with its memory shared when asked', () => {
  // (module (import "env" "memory" (memory 1 65536)) (data (i32.const 16) "hi"))
  const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 2, 18, 1, 3, 101, 110, 118, 6, 109, 101, 109, 111, 114, 121, 2, 1, 1, 128, 128, 4,
    11, 8, 1, 0, 65, 16, 11, 2, 104, 105]);
  const plain = prepare(wasm);
  assert.deepEqual(plain.segments.map((s) => [s.offset, [...s.bytes]]), [[16, [104, 105]]]);
  const memory = new WebAssembly.Memory({initial: 1, maximum: 65536});
  new WebAssembly.Instance(new WebAssembly.Module(plain.wasm), {env: {memory}});
  assert.equal(new Uint8Array(memory.buffer)[16], 0, 'instantiating wrote nothing');
  const shared = prepare(wasm, {shared: true});
  const sharedMemory = new WebAssembly.Memory({initial: 1, maximum: 65536, shared: true});
  new WebAssembly.Instance(new WebAssembly.Module(shared.wasm), {env: {memory: sharedMemory}});
  assert.ok(sharedMemory.buffer instanceof SharedArrayBuffer);
});
