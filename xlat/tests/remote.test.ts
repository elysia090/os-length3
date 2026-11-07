import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Vfs} from '../runtime/fs.ts';
import {RemoteKernel} from '../runtime/remote.ts';
import {Outbox} from '../runtime/channel.ts';
import {prepare} from '../runtime/share.ts';
import {loadTranslator} from '../runtime/translator.ts';
import {have} from './busybox.ts';

// Each thread in a Worker of its own, memory shared: what a cross-origin
// isolated page runs. Here a thread that never makes a call cannot hold
// the others, and one killed while it computes ends at once.

const stage = new URL('../../os/target/userland/', import.meta.url);

async function shell(script: string, {input = null, said = null}: {input?: string | null; said?: [number, string][] | null} = {}): Promise<{status: number; out: string; ms: number}> {
  const vfs = new Vfs();
  const busybox = vfs.writeFile('/bin/busybox', readFileSync(new URL('busybox', stage)), 0o755);
  for (const a of ['sh', 'sleep', 'cat', 'kill', 'echo', 'dd', 'wc', 'sha256sum', 'yes', 'head']) vfs.symlink('busybox', `/bin/${a}`);
  let out = '';
  const typed = input ? [new TextEncoder().encode(input)] : [];
  const kernel = new RemoteKernel({
    vfs, translate: await loadTranslator(readFileSync(new URL('xlat.wasm', stage))),
    console: {
      interactive: false,
      write: (fd, b) => { const text = new TextDecoder().decode(b); out += text; said?.push([fd, text]); },
      read: () => typed.shift() ?? new Uint8Array(0),
      ready: () => true,
    },
  });
  const {wasm, segments} = prepare(readFileSync(new URL('busybox.wasm', stage)), {shared: true});
  kernel.prebuilt(busybox, new WebAssembly.Module(wasm), segments);
  const t0 = performance.now();
  const status = await kernel.spawn('/bin/sh', ['/bin/sh', '-c', script], ['PATH=/bin'], '/');
  return {status, out, ms: performance.now() - t0};
}

test('apart: a background job and its shell run at once', {skip: !have}, async () => {
  const r = await shell('sleep 1 & echo READY; wait; echo DONE');
  assert.equal(r.out, 'READY\nDONE\n');
  assert.equal(r.status, 0);
});

test('apart: a job that computes without a call does not hold the shell, and kill ends it there', {skip: !have}, async () => {
  const r = await shell('(while :; do :; done) & p=$!; sleep 1; echo still here; kill $p; wait $p; echo "status $?"');
  assert.equal(r.out, 'still here\nstatus 143\n');
});

test('apart: a pipe streams between two Workers, every byte', {skip: !have}, async () => {
  const r = await shell('dd if=/dev/zero bs=64k count=200 2>/dev/null | wc -c');
  assert.equal(r.out.trim(), String(200 * 65536));
});

test('apart: traps and SIGPIPE as on Linux', {skip: !have}, async () => {
  const r = await shell('trap "echo got USR1" USR1; kill -USR1 $$; (yes; echo "yes $?" >&2) | head -n 1; echo after');
  assert.equal(r.out, 'got USR1\ny\nyes 141\nafter\n');
});

test('apart: what threads write to the console comes in the order written, stderr told apart', {skip: !have}, async () => {
  const said: [number, string][] = [];
  const r = await shell('for i in 1 2 3; do echo o$i; echo e$i >&2; done; (echo child; echo childerr >&2); echo last', {said});
  assert.equal(r.out, 'o1\ne1\no2\ne2\no3\ne3\nchild\nchilderr\nlast\n');
  const errs = said.filter(([fd]) => fd === 2).map(([, t]) => t).join('');
  assert.equal(errs, 'e1\ne2\ne3\nchilderr\n');
});

test('apart: a flood written a line at a time to the console comes whole', {skip: !have}, async () => {
  const r = await shell('yes | head -c 300000 | (cat; echo end)');
  assert.equal(r.out.length, 300004);
  assert.ok(r.out.endsWith('y\ny\nend\n'));
});

test('the console outbox: writes in order round the ring, fds kept, none past its room', () => {
  const box = new Outbox(new SharedArrayBuffer(16 + 64));
  const from = new TextEncoder().encode('abcdefghijklmnopqrstuvwxyz');
  const out: {fd: number; bytes: Uint8Array}[] = [];
  for (let k = 0; k < 20; k++) {
    assert.equal(box.put(k % 3 ? 1 : 2, from, [[k, 3], [0, 1]], 4) !== null, true);
    if (k % 4 === 3) out.push(...box.take());
  }
  out.push(...box.take());
  const want: [number, string][] = [];
  for (let k = 0; k < 20; k++) want.push([k % 3 ? 1 : 2, String.fromCharCode(97 + k, 98 + k, 99 + k) + 'a']);
  // Writes in a row to one fd come as one.
  const flat = out.map(({fd, bytes}): [number, string] => [fd, new TextDecoder().decode(bytes)]);
  assert.equal(flat.map(([, t]) => t).join(''), want.map(([, t]) => t).join(''));
  for (const [fd, t] of flat) assert.ok(want.filter(([f]) => f === fd).map(([, w]) => w).join('').includes(t));
  // Full: a write that does not fit is refused whole, and what fits still goes in.
  assert.equal(box.put(1, from, [[0, 26]], 26), true);
  assert.equal(box.put(1, from, [[0, 26]], 26), false);
  assert.equal(box.put(1, from, [[0, 26]], 26), null);
  assert.equal(new TextDecoder().decode(box.take()[0].bytes), 'abcdefghijklmnopqrstuvwxyz'.repeat(2));
});
