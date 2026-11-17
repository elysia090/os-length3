import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {loadCoreFiles, CoreFileError, type CoreFile} from '../../runtime/core/files.ts';
import {loadFileScope} from '../../runtime/linux/core-files.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {Description} from '../../runtime/linux/fd.ts';
import {ReadLifetimeError} from '../../runtime/linux/read-lifetime.ts';
const wasm = process.env.SODS_CORE_WASM, enc = new TextEncoder(), dec = new TextDecoder();
const memory = () => Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
const call = (p: Process, nr: number, ...args: number[]) => p.syscall(BigInt(nr), ...([...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]));
const conflict = (e: unknown) => e instanceof CoreFileError && e.code === -8;
test('Rust lazy attempt rejects swallowed reentry and retries once for all readers', {skip: !wasm}, async () => {
  const store = await loadCoreFiles(readFileSync(wasm!), 64); let loads = 0, nested = true;
  const file: CoreFile = store.createLazy(() => { loads++; if (nested) { nested = false; assert.throws(() => file.read(0,3), conflict); } return enc.encode('abc'); });
  assert.throws(() => file.read(0,3), conflict); assert.equal(loads, 1);
  assert.equal(dec.decode(file.read(0,3)), 'abc'); assert.equal(dec.decode(file.read(0,3)), 'abc'); assert.equal(loads, 2);
  file.close();
});
test('Rust lazy other-inode nesting, failure retry and close-stale', {skip: !wasm}, async () => {
  const store = await loadCoreFiles(readFileSync(wasm!), 64); let fail = true;
  const b = store.createLazy(() => enc.encode('B'));
  const a = store.createLazy(() => { const bytes = b.read(0,2); if (fail) throw new Error('source'); return bytes; });
  assert.throws(() => a.read(0,2), /source/); fail = false;
  assert.equal(dec.decode(a.read(0,2)), 'B');
  const closing: CoreFile = store.createLazy(() => { closing.close(); return enc.encode('bad'); });
  assert.throws(() => closing.read(0,3), /closed/); assert.throws(() => closing.read(0,3), /closed/);
  a.close(); b.close();
});
test('Rust lazy inode runs through two processes, append and truncate', {skip: !wasm}, async () => {
  const scope = await loadFileScope(readFileSync(wasm!), 64);
  const k = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const ps = [new Process(k, null), new Process(k, null)]; for (const p of ps) p.memory = memory();
  let loads = 0, nested = true, inner: bigint | undefined;
  const file = scope.lazyFile(k.vfs, '/tmp/lazy', () => { loads++; if (nested) { nested = false; inner = call(ps[1], 0, 0, 1024, 3); } return enc.encode('abc'); });
  for (const p of ps) p.fds.install(new Description('file', {node: file, flags: 2}));
  assert.equal(call(ps[0],0,0,1024,3), -5n); assert.equal(inner, -5n);
  for (const p of ps) { assert.equal(p.fds.get(0)!.offset,0); assert.equal(p.bytes[1024],0); }
  for (const p of ps) assert.equal(call(p,0,0,1024,3),3n);
  assert.equal(loads,2); assert.equal(file.size,3);
  ps[0].fds.get(0)!.flags |= 0x400; ps[0].bytes[1024] = 100;
  assert.equal(call(ps[0],1,0,1024,1),1n); assert.equal(dec.decode(file.bytes()),'abcd');
  assert.equal(call(ps[0],77,0,2),0n); assert.equal(dec.decode(file.bytes()),'ab');
  scope.dispose();
});
test('Rust lazy read checks process identity after callback before copying', {skip: !wasm}, async () => {
  const scope = await loadFileScope(readFileSync(wasm!), 64);
  const k = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(k,null); p.memory = memory(); const old = p.memory;
  const file = scope.lazyFile(k.vfs,'/tmp/a',() => { p.memory = memory(); return enc.encode('abc'); });
  p.fds.install(new Description('file',{node:file,flags:2}));
  assert.throws(() => call(p,0,0,1024,3),ReadLifetimeError);
  assert.equal(new Uint8Array(old.buffer)[1024],0); assert.equal(dec.decode(file.bytes()),'abc');
  scope.dispose();
});
test('Rust lazy syscall loader throw returns EIO without offset change and can retry', {skip: !wasm}, async () => {
  const scope = await loadFileScope(readFileSync(wasm!),64);
  const k = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(k,null); p.memory = memory(); let fail = true;
  const file = scope.lazyFile(k.vfs,'/tmp/a',() => { if (fail) throw new Error('source unavailable'); return enc.encode('abc'); });
  p.fds.install(new Description('file',{node:file,flags:2}));
  assert.equal(call(p,0,0,1024,3),-5n); assert.equal(p.fds.get(0)!.offset,0); assert.equal(file.size,0);
  fail = false; assert.equal(call(p,0,0,1024,3),3n); scope.dispose();
});
test('Rust lazy oversized source retires attempt and scope disposal during load cannot adopt', {skip: !wasm}, async () => {
  const store = await loadCoreFiles(readFileSync(wasm!),3); let large = true;
  const file = store.createLazy(() => enc.encode(large ? 'large' : 'ok'));
  assert.throws(() => file.read(0,3),(e: unknown) => e instanceof CoreFileError && e.code === -2); large = false;
  assert.equal(dec.decode(file.read(0,3)),'ok'); file.close();
  const scope = await loadFileScope(readFileSync(wasm!),64);
  const {Vfs} = await import('../../runtime/linux/fs.ts');
  const closing = scope.lazyFile(new Vfs(),'/a',() => { scope.dispose(); return enc.encode('never'); });
  assert.throws(() => closing.bytes(),/closed/);
  assert.throws(() => closing.bytes(),/closed/);
});
for (const operation of ['given','own','release','map','settle']) test(`Rust inode ${operation} reentry poisons the owning attempt`, {skip: !wasm}, async () => {
  const scope = await loadFileScope(readFileSync(wasm!),64);
  const {Vfs, FsError, E} = await import('../../runtime/linux/fs.ts');
  let nested = true;
  const io = (e: unknown) => e instanceof FsError && e.errno === E.IO;
  const file = scope.lazyFile(new Vfs(),'/a',() => {
    if (nested) {
      nested = false;
      assert.throws(() => {
        if (operation === 'given') file.given(enc.encode('inner'));
        else if (operation === 'own') file.own();
        else if (operation === 'release') file.release();
        else if (operation === 'settle') file.settle();
        else file.map({proc:{bytes:enc.encode('x')},start:0,length:1,off:0});
      },io);
    }
    return enc.encode('outer');
  });
  assert.throws(() => file.bytes(),io); assert.equal(file.size,0); assert.equal(file.version,0); assert.equal(file.maps,null);
  assert.equal(dec.decode(file.bytes()),'outer'); scope.dispose();
});
