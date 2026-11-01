import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {File, Vfs} from '../runtime/fs.mjs';
import {Kernel, PROFILE} from '../runtime/process.mjs';
import {loadTranslator} from '../runtime/translator.mjs';
import {have} from './busybox.mjs';

// What one run translated, kept for the next: the code a program reached later (Image.adopt), and a whole program's
// translation taken from a keeper (Kernel.image) instead of being made again. The next run says the same and
// translates nothing.

const stage = new URL('../../os/target/userland/', import.meta.url);
// One shell, no program run again by exec: a program run again is translated again as one module once it has reached
// enough later (Kernel.consolidate), and what it reaches after follows on from that one, not from its first.
const SCRIPT = 'echo one; for x in a b c; do echo $x; done | while read l; do echo "$l"; done; printf "%s-%d\\n" two 2; test -d / && echo three';

/**
 * A kernel over BusyBox, prebuilt with its first translation as a program run as it runs has it (the Prompt's, made
 * whole ahead of time, reaches nothing later), and a second copy of it as a root file, /usr/bin/echo (`origin`,
 * translated when run).
 */
async function kernel({keeper = null} = {}) {
  const vfs = new Vfs();
  const elf = readFileSync(new URL('busybox', stage));
  vfs.writeFile('/bin/busybox', elf, 0o755);
  for (const a of ['sh', 'cat', 'printf', 'test']) vfs.symlink('busybox', `/bin/${a}`);
  // As a pack's file is (pack.mjs): its bytes read when it is first read, its origin where they are.
  const reads = {n: 0};
  const file = new File(new Uint8Array(0), 0o755, () => { reads.n++; return new Uint8Array(elf); });
  file.size = elf.length;
  file.origin = 'pack_0_1';
  vfs.mkdirp('/usr/bin').entries.set('echo', file);
  let out = '';
  const translate = await loadTranslator(readFileSync(new URL('xlat.wasm', stage)));
  const k = new Kernel({
    vfs, keeper, translate,
    console: {interactive: false, write: (_, b) => { out += new TextDecoder().decode(b); }, read: () => null, ready: () => false},
  });
  k.prebuilt(vfs.lookup('/bin/busybox', '/'), new WebAssembly.Module(translate(new Uint8Array(elf))));
  return {k, vfs, reads, out: () => out};
}

/** Run `script` to the end, the kernel looked at again whenever it waits (a keeper being read). */
async function run(k, script) {
  k.start('/bin/sh', ['/bin/sh', '-c', script], ['PATH=/bin:/usr/bin'], '/');
  for (let i = 0; i < 200; i++) {
    const r = k.pump();
    if (!r.waiting) return r.status;
    await new Promise((go) => setTimeout(go, 5));
  }
  throw new Error('it never ended');
}

const busybox = (k, vfs) => k.images.get(vfs.lookup('/bin/busybox', '/')).image;

test('kept: code a run reached later is taken in by the next, which translates none of it again', {skip: !have}, async () => {
  const a = await kernel();
  assert.equal(await run(a.k, SCRIPT), 0);
  const made = busybox(a.k, a.vfs).extras;
  assert.ok(made.length > 0, 'the first run reaches code later');
  const b = await kernel();
  const image = busybox(b.k, b.vfs);
  assert.equal(image.adopt(made.map(({module, bytes, base}) => ({module, bytes, base}))), made.length);
  const before = PROFILE.modules;
  assert.equal(await run(b.k, SCRIPT), 0);
  assert.equal(b.out(), a.out());
  assert.equal(PROFILE.modules - before, 0, 'nothing translated again');
  assert.equal(image.extras.length, made.length);
});

test('kept: modules that do not follow on from what is there are not taken', {skip: !have}, async () => {
  const a = await kernel();
  await run(a.k, SCRIPT);
  const made = busybox(a.k, a.vfs).extras;
  const b = await kernel();
  // From the second on, as if the first were missing: none follows on.
  assert.equal(busybox(b.k, b.vfs).adopt(made.slice(1)), 0);
  assert.equal(await run(b.k, SCRIPT), 0);
  assert.equal(b.out(), a.out());
});

test('kept: a root program translated once is taken from the keeper by the next kernel, which waits for it', {skip: !have}, async () => {
  const a = await kernel();
  assert.equal(await run(a.k, '/usr/bin/echo echo kept'), 0);
  const other = a.vfs.lookup('/usr/bin/echo', '/');
  const im = a.k.images.get(other).image;
  assert.equal(im.origin, 'pack_0_1');
  assert.ok(im.wasm?.length, 'what was translated is there to keep');
  const kept = {module: new WebAssembly.Module(im.wasm), segments: im.segments, size: im.size,
    more: im.extras.map(({module, bytes, base}) => ({module, bytes, base}))};
  let asked = 0;
  const keeper = {has: (origin) => origin === 'pack_0_1', take: () => (++asked === 1 ? undefined : kept)};
  const b = await kernel({keeper});
  const before = PROFILE.images;
  assert.equal(await run(b.k, '/usr/bin/echo echo kept'), 0);
  assert.equal(b.out(), a.out());
  assert.equal(PROFILE.images - before, 0, 'not translated again');
  assert.ok(asked >= 2, 'the exec waited for it, then took it');
  // Nor was the program itself read: it had a translation (the first kernel read it, to translate it).
  assert.equal(a.reads.n, 1);
  assert.equal(b.reads.n, 0);
});
