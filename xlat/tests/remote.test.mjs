import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Vfs} from '../runtime/fs.mjs';
import {RemoteKernel} from '../runtime/remote.mjs';
import {prepare} from '../runtime/share.mjs';
import {loadTranslator} from '../runtime/translator.mjs';
import {have} from './busybox.mjs';

// Each thread in a Worker of its own, memory shared: what a cross-origin
// isolated page runs. Here a thread that never makes a call cannot hold
// the others, and one killed while it computes ends at once.

const stage = new URL('../../os/target/userland/', import.meta.url);

async function shell(script, {input = null} = {}) {
  const vfs = new Vfs();
  vfs.writeFile('/bin/busybox', readFileSync(new URL('busybox', stage)), 0o755);
  for (const a of ['sh', 'sleep', 'cat', 'kill', 'echo', 'dd', 'wc', 'sha256sum', 'yes', 'head']) vfs.symlink('busybox', `/bin/${a}`);
  let out = '';
  const typed = input ? [new TextEncoder().encode(input)] : [];
  const kernel = new RemoteKernel({
    vfs, translate: await loadTranslator(readFileSync(new URL('xlat.wasm', stage))),
    console: {
      interactive: false,
      write: (_, b) => { out += new TextDecoder().decode(b); },
      read: () => typed.shift() ?? new Uint8Array(0),
      ready: () => true,
    },
  });
  const {wasm, segments} = prepare(readFileSync(new URL('busybox.wasm', stage)), {shared: true});
  kernel.prebuilt(vfs.lookup('/bin/busybox', '/'), new WebAssembly.Module(wasm), segments);
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
