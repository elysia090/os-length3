import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {File, Vfs} from '../../runtime/linux/fs.ts';
import {Kernel, PROFILE, type Image, type Keeper} from '../../runtime/linux/process.ts';
import type {Taken} from '../../runtime/kept.ts';
import {loadTranslator} from '../../runtime/translator.ts';
import {have} from './busybox.ts';

// What one run translated, kept for the next: the code a program reached later (Image.adopt), and a whole program's
// translation taken from a keeper (Kernel.image) instead of being made again. The next run says the same and
// translates nothing.

const stage = new URL('../../../../target/userland/', import.meta.url);
// One shell, no program run again by exec: a program run again is translated again as one module once it has reached
// enough later (Kernel.consolidate), and what it reaches after follows on from that one, not from its first.
const SCRIPT = 'echo one; for x in a b c; do echo $x; done | while read l; do echo "$l"; done; printf "%s-%d\\n" two 2; test -d / && echo three';

/**
 * A kernel over BusyBox, prebuilt with its first translation as a program run as it runs has it (the Prompt's, made
 * whole ahead of time, reaches nothing later), and a second copy of it as a root file, /usr/bin/echo (`origin`,
 * translated when run).
 */
async function kernel({keeper = null}: {keeper?: Keeper | null} = {}): Promise<{k: Kernel; vfs: Vfs; reads: {n: number}; out: () => string}> {
  const vfs = new Vfs();
  const elf = readFileSync(new URL('busybox', stage));
  const busybox = vfs.writeFile('/bin/busybox', elf, 0o755);
  for (const a of ['sh', 'cat', 'printf', 'test']) vfs.symlink('busybox', `/bin/${a}`);
  // As a pack's file is (pack.ts): its bytes read when it is first read, its origin where they are.
  const reads = {n: 0};
  const file = new File(new Uint8Array(0), 0o755, () => { reads.n++; return new Uint8Array(elf); });
  file.size = elf.length;
  file.origin = 'pack_0_1';
  vfs.mkdirp('/usr/bin').entries.set('echo', file);
  let out = '';
  const translate = await loadTranslator(readFileSync(new URL('sods.wasm', stage)));
  const k = new Kernel({
    vfs, keeper, translate,
    console: {interactive: false, write: (_, b) => { out += new TextDecoder().decode(b); }, read: () => null, ready: () => false},
  });
  k.prebuilt(busybox, new WebAssembly.Module(translate(new Uint8Array(elf))));
  return {k, vfs, reads, out: () => out};
}

/** Run `script` to the end, the kernel looked at again whenever it waits (a keeper being read). */
async function run(k: Kernel, script: string): Promise<number | undefined> {
  k.start('/bin/sh', ['/bin/sh', '-c', script], ['PATH=/bin:/usr/bin'], '/');
  for (let i = 0; i < 200; i++) {
    const r = k.pump();
    if (!r.waiting) return r.status;
    await new Promise((go) => setTimeout(go, 5));
  }
  throw new Error('it never ended');
}

const busybox = (k: Kernel, vfs: Vfs): Image => k.images.get(vfs.file('/bin/busybox'))!.image;

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
  const other = a.vfs.file('/usr/bin/echo');
  const im = a.k.images.get(other)!.image;
  assert.equal(im.origin, 'pack_0_1');
  assert.ok(im.wasm?.length, 'what was translated is there to keep');
  const kept: Taken = {module: new WebAssembly.Module(im.wasm!), segments: im.segments, size: im.size,
    more: im.extras.map(({module, bytes, base}) => ({module, bytes, base}))};
  let asked = 0;
  const keeper: Keeper = {has: (origin) => origin === 'pack_0_1', take: () => (++asked === 1 ? undefined : kept)};
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

test('kept: a root program translated ahead (ahead.ts, as the page does while a person reads) is run from that, never translated or read', {skip: !have}, async () => {
  const {translatedAhead} = await import('../../runtime/ahead.ts');
  const elf = readFileSync(new URL('busybox', stage));
  // As its pack holds it, zstd's frame or as it is: here as it is.
  const {wasm, segments} = await translatedAhead(readFileSync(new URL('sods.wasm', stage)), new Uint8Array(elf), {raw: true, size: elf.length, shared: false});
  const kept: Taken = {module: new WebAssembly.Module(wasm), segments, size: wasm.length, more: []};
  let asked = 0;
  const keeper: Keeper = {has: (origin) => origin === 'pack_0_1', take: () => (++asked === 1 ? undefined : kept)};
  const a = await kernel();
  assert.equal(await run(a.k, '/usr/bin/echo echo ahead'), 0);
  const b = await kernel({keeper});
  const before = PROFILE.images;
  assert.equal(await run(b.k, '/usr/bin/echo echo ahead'), 0);
  assert.equal(b.out(), a.out());
  assert.equal(PROFILE.images - before, 0, 'not translated when run');
  assert.equal(b.reads.n, 0, 'nor read');
});

test('kept: a program whose file changed before the code it reached later was read from it keeps none of that', {skip: !have}, async () => {
  // A root program's translation taken from the keeper, with none of what it reaches later: that is translated from
  // the file once it is reached.
  const a = await kernel();
  assert.equal(await run(a.k, '/usr/bin/echo echo kept'), 0);
  const im = a.k.images.get(a.vfs.file('/usr/bin/echo'))!.image;
  const kept: Taken = {module: new WebAssembly.Module(im.wasm!), segments: im.segments, size: im.size, more: []};
  let asked = 0;
  const keeper: Keeper = {has: (origin) => origin === 'pack_0_1', take: () => (++asked === 1 ? undefined : kept)};
  const b = await kernel({keeper});
  const echo = b.vfs.file('/usr/bin/echo');
  assert.throws(() => b.k.image(echo, true), 'it waits for what is kept to be read');
  const taken = b.k.image(echo, true);
  assert.equal(taken.origin, 'pack_0_1');
  // Written after it was taken and before its bytes were first read: what is read now is not what it was made from.
  echo.write(echo.size - 1, new Uint8Array([0]));
  taken.source!();
  assert.equal(taken.origin, undefined, 'no longer the root file\'s: what it reaches is never kept under its origin');
  assert.ok(taken.changed);
  // A program given with its translation (a hot one: what it reaches is kept by its path) is held to the same.
  const busy = b.vfs.file('/bin/busybox'), hot = busybox(b.k, b.vfs);
  busy.write(busy.size - 1, new Uint8Array([0]));
  hot.source!();
  assert.ok(hot.changed);
  // Unchanged, the bytes read later are its own, and it stays the file's.
  const c = await kernel({keeper: {has: (origin) => origin === 'pack_0_1', take: () => kept}});
  const same = c.k.image(c.vfs.file('/usr/bin/echo'), true);
  same.source!();
  assert.equal(same.origin, 'pack_0_1');
  assert.ok(!same.changed && !busybox(c.k, c.vfs).changed);
});
