import assert from 'node:assert/strict';
import {test} from 'node:test';
import {File, FsError, E} from '../../runtime/linux/fs.ts';
import {Description} from '../../runtime/linux/fd.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';
const enc = new TextEncoder(), dec = new TextDecoder();
const io = (error: unknown) => error instanceof FsError && error.errno === E.IO;
for (const action of ['read', 'given', 'own', 'release', 'write', 'truncate', 'map', 'settle']) test(`same inode ${action} rejects both inner call and outer load, then retries`, () => {
  let nested = true, loads = 0, rejected = false;
  const file = new File(new Uint8Array(0), 0o644, () => {
    loads++;
    if (nested) {
      // Bound the pre-fix reproduction, rather than relying on stack exhaustion.
      nested = false;
      try {
        switch (action) {
          case 'read': file.read(0, 3); break;
          case 'given': file.given(enc.encode('inner')); break;
          case 'own': file.own(); break;
          case 'release': file.release(); break;
          case 'write': file.write(0, enc.encode('inner')); break;
          case 'truncate': file.truncate(1); break;
          case 'map': file.map({proc: {bytes: enc.encode('inner')}, start: 0, off: 0, length: 1}); break;
          case 'settle': file.settle(); break;
        }
      } catch (e) { assert.ok(io(e)); rejected = true; }
    }
    return enc.encode('outer');
  });
  const loader = file.load;
  assert.throws(() => file.bytes(), io);
  assert.equal(rejected, true); assert.equal(loads, 1);
  assert.equal(file.version, 0); assert.equal(file.size, 0); assert.equal(file.maps, null);
  assert.equal(file.load, loader); assert.equal(file.reload, loader);
  assert.equal(dec.decode(file.bytes()), 'outer'); assert.equal(loads, 2);
});
test('different inode nested load remains valid', () => {
  const other = new File(new Uint8Array(0), 0o644, () => enc.encode('other'));
  const file = new File(new Uint8Array(0), 0o644, () => other.bytes());
  assert.equal(dec.decode(file.bytes()), 'other');
});
test('two processes sharing a lazy inode do not publish from a reentrant waiter', () => {
  const k = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const processes = [new Process(k, null), new Process(k, null)];
  for (const p of processes) p.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  const read = (p: Process) => p.syscall(0n, 0n, 1024n, 3n, 0n, 0n, 0n);
  let nested = true, inner: bigint | undefined;
  const file = new File(new Uint8Array(0), 0o644, () => { if (nested) { nested = false; inner = read(processes[1]); } return enc.encode('abc'); });
  for (const p of processes) p.fds.install(new Description('file', {node: file, flags: 2}));
  assert.equal(read(processes[0]), -5n); assert.equal(inner, -5n);
  for (const p of processes) { assert.equal(p.fds.get(0)!.offset, 0); assert.deepEqual([...p.bytes.subarray(1024, 1027)], [0,0,0]); }
  assert.equal(read(processes[0]), 3n); assert.equal(read(processes[1]), 3n);
});
test('A to B to A cycle poisons A but does not roll back B success', () => {
  let retry = false;
  const a = new File(new Uint8Array(0), 0o644, () => retry ? enc.encode('retry') : b.bytes());
  const b = new File(new Uint8Array(0), 0o644, () => { assert.throws(() => a.bytes(), io); return enc.encode('B'); });
  assert.throws(() => a.bytes(), io);
  assert.equal(dec.decode(b.bytes()), 'B'); assert.notEqual(a.load, null);
  retry = true; assert.equal(dec.decode(a.bytes()), 'retry');
});
test('ordinary loader throw resets the attempt for a later retry', () => {
  let fail = true;
  const file = new File(new Uint8Array(0), 0o644, () => { if (fail) throw new Error('expected source failure'); return enc.encode('ok'); });
  assert.throws(() => file.bytes(), io); fail = false;
  assert.equal(dec.decode(file.bytes()), 'ok');
});
test('lazy source can read an independent Rust inode without retaining its read lease', {skip: !process.env.SODS_CORE_WASM}, async () => {
  const {readFileSync} = await import('node:fs');
  const {loadFileScope} = await import('../../runtime/linux/core-files.ts');
  const {Vfs} = await import('../../runtime/linux/fs.ts');
  const scope = await loadFileScope(readFileSync(process.env.SODS_CORE_WASM!), 64);
  try {
    const core = scope.writeFile(new Vfs(), '/source', 'abc');
    const lazy = new File(new Uint8Array(0), 0o644, () => core.bytes());
    assert.equal(dec.decode(lazy.bytes()), 'abc');
    core.write(0, enc.encode('xyz'));
    assert.equal(dec.decode(core.bytes()), 'xyz'); assert.equal(dec.decode(lazy.bytes()), 'abc');
  } finally { scope.dispose(); }
});
