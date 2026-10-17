import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {Vfs} from '../runtime/fs.mjs';
import {Kernel} from '../runtime/process.mjs';
import {loadTranslator} from '../runtime/translator.mjs';

// BusyBox as the Prompt has it (os/scripts/userland.sh stages it).
const stage = new URL('../../os/target/userland/', import.meta.url);
const have = ['busybox', 'busybox.wasm', 'xlat.wasm'].every((f) => existsSync(new URL(f, stage)));

test('Ctrl-C ends what waits in front of the shell, and the shell goes on', {skip: !have}, async () => {
  const vfs = new Vfs();
  vfs.writeFile('/bin/busybox', readFileSync(new URL('busybox', stage)), 0o755);
  for (const a of ['sh', 'cat']) vfs.symlink('busybox', `/bin/${a}`);
  const input = [];
  let out = '';
  const kernel = new Kernel({
    vfs, translate: await loadTranslator(readFileSync(new URL('xlat.wasm', stage))),
    console: {
      interactive: false,
      write: (_, b) => { out += new TextDecoder().decode(b); },
      read: () => input.shift() ?? null,
      ready: () => input.length > 0,
    },
  });
  kernel.prebuilt(vfs.lookup('/bin/busybox', '/'), new WebAssembly.Module(readFileSync(new URL('busybox.wasm', stage))));
  kernel.start('/bin/sh', ['/bin/sh', '-c', 'cat; echo "after $?"'], ['PATH=/bin'], '/');
  // cat waits for input that does not come.
  assert.deepEqual(kernel.pump(), {waiting: true});
  assert.ok(kernel.interrupt());
  assert.deepEqual(kernel.pump(), {status: 0});
  assert.equal(out, 'after 130\n');
  // With only the shell left there is nothing to interrupt.
  assert.equal(kernel.interrupt(), false);
});
