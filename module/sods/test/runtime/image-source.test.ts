import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {loadFileScope} from '../../runtime/linux/core-files.ts';
import {File, FsError, E} from '../../runtime/linux/fs.ts';
import {Kernel, Process, ImageSourceChangedError} from '../../runtime/linux/process.ts';
import {ReadLifetimeError} from '../../runtime/linux/read-lifetime.ts';
const enc = new TextEncoder(), name = enc.encode('sods.facts'), facts = enc.encode('{}');
// A valid minimal module for image-cache tests, not an executable translated program.
const wasm = new Uint8Array([0,97,115,109,1,0,0,0,0,1+name.length+facts.length,name.length,...name,...facts]);
const module = new WebAssembly.Module(wasm), elf = () => Uint8Array.of(127,69,76,70,1);
const quiet = {write() {}, read: () => new Uint8Array(0)};
test('old source bytes are never stamped as a newly changed inode revision', () => {
  let file: File, change = true, calls = 0;
  const k = new Kernel({console: quiet, translate() { calls++; if (change) file.write(4, Uint8Array.of(2)); return wasm; }});
  file = k.vfs.writeFile('/p', elf(), 0o755);
  assert.throws(() => k.image(file), ImageSourceChangedError);
  assert.equal(calls, 1); assert.equal(k.images.has(file), false); assert.equal(file.version, 1);
  change = false;
  const image = k.image(file);
  assert.equal(calls, 2); assert.equal(k.images.get(file)!.version, 1); assert.equal(image.source!()[4], 2);
});
test('normal dirty executable mapping settles before capturing the revision', () => {
  const k = new Kernel({console: quiet, translate: () => wasm}), file = k.vfs.writeFile('/p', elf(), 0o755);
  const m = {proc: {bytes: elf()}, start: 0, length: 5, off: 0}; file.map(m); m.proc.bytes[4] = 2;
  const image = k.image(file);
  assert.equal(file.version, 1); assert.equal(k.images.get(file)!.version, 1); assert.equal(image.source!()[4], 2);
  file.unmap(m);
});
for (const where of ['translate', 'classifier']) test(`source changes during ${where} cannot become ordinary ENOEXEC`, () => {
  let file: File, classified = 0;
  const translate = Object.assign(() => { if (where === 'translate') file.write(4, Uint8Array.of(2)); throw new Error('reject'); }, {
    notProgram() { classified++; if (where === 'classifier') file.write(4, Uint8Array.of(2)); return true; },
  });
  const k = new Kernel({console: quiet, translate}); file = k.vfs.writeFile('/p', elf(), 0o755);
  assert.throws(() => k.image(file), ImageSourceChangedError);
  assert.equal(classified, where === 'translate' ? 0 : 1); assert.equal(k.images.has(file), false);
});
for (const where of ['has', 'take']) test(`keeper ${where} cannot adopt a changed source`, () => {
  let file: File, takes = 0;
  const k = new Kernel({console: quiet, keeper: {
    has() { if (where === 'has') file.write(4, Uint8Array.of(2)); return true; },
    take() { takes++; file.write(4, Uint8Array.of(2)); return {module, segments: null, size: wasm.length, more: []}; },
  }});
  file = k.vfs.writeFile('/p', elf(), 0o755); file.origin = 'source';
  assert.throws(() => k.image(file, true), ImageSourceChangedError);
  assert.equal(takes, where === 'has' ? 0 : 1); assert.equal(k.images.has(file), false);
});
test('consolidation cannot make an old cache entry valid for a changed inode', () => {
  let file: File;
  const translate = Object.assign(() => wasm, {seeded() { file.write(4, Uint8Array.of(2)); return wasm; }});
  const k = new Kernel({console: quiet, translate}); file = k.vfs.writeFile('/p', elf(), 0o755);
  const image = k.image(file);
  for (let i = 0; i < 16; i++) image.extras.push({module, base: 0, count: 0, bytes: wasm});
  assert.throws(() => k.image(file), ImageSourceChangedError);
  assert.equal(file.version, 1); assert.equal(k.images.get(file)!.version, 0);
});
test('unchanged translator rejection keeps ordinary ENOEXEC semantics', () => {
  const k = new Kernel({console: quiet, translate: Object.assign(() => { throw new Error('not a program'); }, {notProgram: () => true})});
  const file = k.vfs.writeFile('/p', elf(), 0o755);
  assert.throws(() => k.image(file), (error: unknown) => error instanceof FsError && error.errno === E.NOEXEC);
});
const memory = () => Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
const call = (p: Process, nr: number, ...args: number[]) => p.syscall(BigInt(nr), ...([...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]));
for (const throws of [false, true]) test(`exec checks process identity after translator callback, throws=${throws}`, () => {
  let p: Process;
  const k = new Kernel({console: quiet, translate() { p.memory = memory(); if (throws) throw new Error('translation failed'); return wasm; }});
  p = new Process(k, null); p.memory = memory(); p.fixed = []; p.free = []; p.mapBase = p.mapEnd = p.stackTop = 65536; p.stackLow = 0;
  k.vfs.writeFile('/p', elf(), 0o755); p.bytes.set(enc.encode('/p\0'), 1024);
  assert.throws(() => call(p, 59, 1024, 0, 0), ReadLifetimeError);
  assert.equal(p.state, 'zombie'); assert.equal(p.image, undefined);
});
test('exec head source replacement then throw is not returned as EIO to a new image', () => {
  const k = new Kernel({console: quiet}), p = new Process(k, null);
  p.memory = memory(); p.fixed = []; p.free = []; p.mapBase = p.mapEnd = p.stackTop = 65536; p.stackLow = 0;
  k.vfs.root.entries.set('p', new File(new Uint8Array(0), 0o755, () => { p.memory = memory(); throw new Error('head source changed process'); }));
  p.bytes.set(enc.encode('/p\0'), 1024);
  assert.throws(() => call(p, 59, 1024, 0, 0), ReadLifetimeError);
  assert.equal(p.state, 'zombie'); assert.equal(p.image, undefined);
});

const coreWasm = process.env.SODS_CORE_WASM;
test('Rust-backed executable source is checked after completed copy and translation callback', {skip: !coreWasm}, async () => {
  const scope = await loadFileScope(readFileSync(coreWasm!), 32);
  let file: File, change = true;
  const k = new Kernel({console: quiet, translate() { if (change) file.write(4, Uint8Array.of(2)); return wasm; }});
  file = scope.writeFile(k.vfs, '/p', elf(), 0o755);
  assert.throws(() => k.image(file), ImageSourceChangedError);
  assert.equal(k.images.has(file), false); assert.equal(file.version, 1);
  change = false;
  assert.equal(k.image(file).source!()[4], 2);
  assert.equal(k.images.get(file)!.version, 1);
  scope.dispose();
});
