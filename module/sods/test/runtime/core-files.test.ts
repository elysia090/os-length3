import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {loadCoreFiles} from '../../runtime/core/files.ts';

const wasm = process.env.SODS_CORE_WASM;
const enc = new TextEncoder(), dec = new TextDecoder();
// Explicit artifact input: no downloads, builds, fake core or silent native fallback.
test('real Rust Wasm owns payloads across growth, failure and closed handles', {skip: !wasm}, async () => {
  const files = await loadCoreFiles(readFileSync(wasm!), 200000);
  const input = enc.encode('old');
  const a = files.create(input);
  input.fill(120);
  assert.equal(dec.decode(a.read(0, 99)), 'old');
  const into = new Uint8Array(5).fill(33);
  assert.equal(a.readInto(1, into, 2, 99), 2);
  assert.deepEqual([...into], [33, 33, 108, 100, 33]);
  assert.throws(() => a.readInto(0, into, 4, 3), RangeError);
  assert.equal(a.readInto(99, into, 5, 1), 0);
  const old = a.read(0, 99);
  a.write(5, enc.encode('z'));
  assert.deepEqual(a.read(0, 99), new Uint8Array([111, 108, 100, 0, 0, 122]));
  a.truncate(2); a.truncate(6);
  assert.deepEqual(a.read(0, 99), new Uint8Array([111, 108, 0, 0, 0, 0]));
  assert.equal(dec.decode(old), 'old');
  assert.throws(() => a.write(0xffffffff, enc.encode('x')));
  assert.throws(() => a.truncate(200001));
  assert.deepEqual(a.read(0, 99), new Uint8Array([111, 108, 0, 0, 0, 0]));
  const large = files.create(new Uint8Array(150000).fill(23));
  assert.equal(large.read(149999, 8)[0], 23);
  assert.equal(dec.decode(old), 'old');
  a.close(); a.close();
  const b = files.create(enc.encode('new'));
  assert.throws(() => a.read(0, 1), /closed/);
  assert.equal(dec.decode(b.read(0, 99)), 'new');
  assert.throws(() => b.read(-1, 1), RangeError);
  assert.throws(() => b.write(0.5, input), RangeError);
  assert.throws(() => b.truncate(NaN), RangeError);
  large.close(); b.close();
});

test('unshared file core does not require SharedArrayBuffer global', {skip: !wasm}, async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'SharedArrayBuffer');
  try {
    Object.defineProperty(globalThis, 'SharedArrayBuffer', {value: undefined, configurable: true});
    const files = await loadCoreFiles(readFileSync(wasm!), 8);
    const f = files.create(enc.encode('a'));
    f.write(4, new Uint8Array(0));
    assert.deepEqual(f.read(0, 8), new Uint8Array([97, 0, 0, 0]));
    f.close();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'SharedArrayBuffer', previous);
    else Reflect.deleteProperty(globalThis, 'SharedArrayBuffer');
  }
});

test('unversioned modules are rejected before file operations', async () => {
  const empty = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  await assert.rejects(loadCoreFiles(empty, 8), /Unsupported core files ABI/);
});

test('real core owns the read lease and rejects overwrite and invalid completion', {skip: !wasm}, () => {
  const exports = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(wasm!)), {}).exports;
  const call = (name: string, ...args: number[]) => (exports[name] as (...n: number[]) => number)(...args);
  const memory = exports.memory as WebAssembly.Memory;
  assert.equal(call('files_abi_version'), 4);
  assert.equal(call('files_init', 32), 0);
  assert.equal(call('files_input', 3), 0);
  new Uint8Array(memory.buffer, call('files_ptr'), 3).set(enc.encode('abc'));
  const id = call('files_create'); assert.ok(id > 0);
  const operation = call('files_read_begin', id, 0, 8); assert.ok(operation > 0);
  assert.equal(call('files_input', 2), -6);
  assert.equal(call('files_create'), -6);
  assert.equal(call('files_write', id, 0), -6);
  assert.equal(call('files_read_begin', id, 0, 2), -6);
  assert.equal(call('files_truncate', id, 1), -6);
  assert.equal(call('files_close', id), -6);
  assert.equal(dec.decode(new Uint8Array(memory.buffer, call('files_ptr'), call('files_len'))), 'abc');
  assert.equal(call('files_read_finish', operation + 1, 0, 3), -7);
  assert.equal(call('files_read_finish', operation, 0, 2), -7);
  assert.equal(call('files_read_finish', operation, 2, 0), -7);
  assert.equal(call('files_close', id), -6);
  assert.equal(call('files_read_finish', operation, 0, 3), 3);
  assert.equal(call('files_read_finish', operation, 0, 3), -7);
  const next = call('files_read_begin', id, 0, 1); assert.ok(next > operation);
  assert.equal(call('files_read_finish', next, 1, 0), 0);
  assert.equal(call('files_close', id), 0);
});

test('previous files ABI is rejected rather than assumed compatible', async () => {
  const name = [...enc.encode('files_abi_version')];
  const section = (id: number, data: number[]) => [id, data.length, ...data];
  const module = new WebAssembly.Module(new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0,
    ...section(1, [1, 0x60, 0, 1, 0x7f]), ...section(3, [1, 0]),
    ...section(7, [1, name.length, ...name, 0, 0]), ...section(10, [1, 4, 0, 0x41, 1, 0x0b]),
  ]));
  await assert.rejects(loadCoreFiles(module, 8), /Unsupported core files ABI/);
});

test('real core transfers exact input scratch, consumes preparation, and avoids retaining oversized scratch per file', {skip: !wasm}, () => {
  const exports = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(wasm!)), {}).exports;
  const call = (name: string, ...args: number[]) => (exports[name] as (...n: number[]) => number)(...args);
  const memory = exports.memory as WebAssembly.Memory;
  const input = (text: string) => { const bytes=enc.encode(text); assert.equal(call('files_input',bytes.length),0);new Uint8Array(memory.buffer,call('files_ptr'),bytes.length).set(bytes); };
  const read = (id: number) => { const op=call('files_read_begin',id,0,64);assert.ok(op>0);const length=call('files_len'),value=dec.decode(new Uint8Array(memory.buffer,call('files_ptr'),length));assert.equal(call('files_read_finish',op,0,length),length);return value; };
  assert.equal(call('files_init',64),0);
  input('first'); const first=call('files_create');assert.ok(first>0);
  assert.equal(call('files_len'),0); // The selected allocator's exact allocation was transferred.
  assert.equal(call('files_create'),-1); // No reusable input permission remains.
  input('other');const second=call('files_create');assert.ok(second>first);
  assert.equal(read(first),'first');assert.equal(read(second),'other');
  assert.equal(call('files_input',64),0);input('x');const small=call('files_create');
  assert.equal(call('files_len'),1); // Oversized capacity remains reusable scratch, not a tiny inode's backing.
  assert.equal(read(small),'x');assert.equal(read(first),'first');
});

test('real core lazy scratch transfer preserves stale/poison retry and independent payloads', {skip: !wasm}, () => {
  const exports = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(wasm!)), {}).exports;
  const call = (name: string, ...args: number[]) => (exports[name] as (...n: number[]) => number)(...args);
  const memory = exports.memory as WebAssembly.Memory;
  const input = (text: string) => {const b=enc.encode(text);assert.equal(call('files_input',b.length),0);new Uint8Array(memory.buffer,call('files_ptr'),b.length).set(b);};
  assert.equal(call('files_init',64),0);
  const id=call('files_create_lazy',1,0), op=call('files_load_begin',id);
  input('abc');assert.equal(call('files_load_finish',id,op+1,0),-7);
  assert.equal(call('files_len'),3); // Rejected completion did not move scratch.
  // ABI input permission is consumed on an attempted completion, as before.
  assert.equal(call('files_load_finish',id,op,0),-7);
  input('abc');assert.equal(call('files_load_finish',id,op,0),3);assert.equal(call('files_len'),0);
  const other=call('files_create_lazy',2,0), next=call('files_load_begin',other);
  input('def');assert.equal(call('files_load_check',other),-8);
  assert.equal(call('files_load_finish',other,next,0),-8);assert.equal(call('files_len'),3);
  const retry=call('files_load_begin',other);assert.ok(retry>next);
  input('def');assert.equal(call('files_load_finish',other,retry,0),3);assert.equal(call('files_len'),0);
  for(const [file,text] of [[id,'abc'],[other,'def']] as const) {
    const read=call('files_read_begin',file,0,3);
    assert.equal(dec.decode(new Uint8Array(memory.buffer,call('files_ptr'),3)),text);
    assert.equal(call('files_read_finish',read,0,3),3);
  }
});

test('resident mapping operations reject unloaded/loading/closed files without invoking a loader',{skip:!wasm},async()=>{
  const store=await loadCoreFiles(readFileSync(wasm!),8);let loads=0;
  const file=store.createLazy(()=>{loads++;assert.throws(()=>file.ownResident(),/core file error -8/);return enc.encode('abc');});
  assert.throws(()=>file.ownResident(),/core file error -8/);
  assert.throws(()=>file.writeResident(0,enc.encode('x')),/core file error -8/);
  assert.equal(loads,0);
  assert.throws(()=>file.materialize(),/core file error -8/);assert.equal(loads,1);
  file.close();assert.throws(()=>file.ownResident(),/closed/);assert.throws(()=>file.writeResident(0,enc.encode('x')),/closed/);
});
test('resident own precedes preparation/write failure and permanently retires the reload source',{skip:!wasm},async()=>{
  const store=await loadCoreFiles(readFileSync(wasm!),8);let loads=0;
  const file=store.createLazy(()=>{loads++;return enc.encode('abc');});
  file.materialize();file.ownResident();
  assert.equal(file.source(),0);
  assert.throws(()=>file.writeResident(0,new Uint8Array(9)),/limit/);
  assert.throws(()=>file.writeResident(8,enc.encode('x')),/core file error -2/);
  assert.equal(file.release(),0);assert.equal(dec.decode(file.read(0,8)),'abc');assert.equal(loads,1);
  file.writeResident(1,enc.encode('Z'));assert.equal(dec.decode(file.read(0,8)),'aZc');file.close();
});

test('real core churn reuses storage without retargeting stale file/load/read identities', {skip: !wasm}, (t) => {
  const module = new WebAssembly.Module(readFileSync(wasm!));
  assert.deepEqual(WebAssembly.Module.imports(module), []);
  const exports = new WebAssembly.Instance(module, {}).exports;
  const call = (name: string, ...args: number[]) => (exports[name] as (...n: number[]) => number)(...args);
  const memory = exports.memory as WebAssembly.Memory;
  assert.equal(call('files_init', 8), 0);
  const first = call('files_create_lazy', 1, 0), oldLoad = call('files_load_begin', first);
  assert.ok(first > 0 && oldLoad > 0); assert.equal(call('files_close', first), 0);
  let previous = first;
  const churn = (count: number) => {
    for (let i = 0; i < count; i++) {
      assert.equal(call('files_input', 0), 0);
      const id = call('files_create'); assert.ok(id > previous); previous = id;
      assert.equal(call('files_close', id), 0);
    }
  };
  churn(200);
  const warmed = memory.buffer.byteLength;
  churn(10_000);
  const after = memory.buffer.byteLength;
  // Artifact-specific allocator evidence, not a universal RSS/capacity bound.
  assert.equal(after, warmed);
  t.diagnostic(`empty-file churn: 200 warmup + 10000 create/close, Wasm bytes ${warmed} -> ${after}`);
  assert.equal(call('files_close', first), 0);
  assert.equal(call('files_close', 0), -1);
  assert.equal(call('files_close', previous + 1), -1);
  assert.equal(call('files_read_begin', first, 0, 0), -1);
  const current = call('files_create_lazy', 2, 0), load = call('files_load_begin', current);
  assert.ok(current > previous && load > oldLoad);
  assert.equal(call('files_input', 0), 0);
  assert.equal(call('files_load_finish', first, oldLoad, 0), -1);
  assert.equal(call('files_input', 0), 0);
  assert.equal(call('files_load_finish', current, load, 0), 0);
  const read = call('files_read_begin', current, 0, 0); assert.ok(read > 0);
  assert.equal(call('files_read_finish', read, 0, 0), 0);
  const nextRead = call('files_read_begin', current, 0, 0); assert.ok(nextRead > read);
  assert.equal(call('files_read_finish', read, 0, 0), -7);
  assert.equal(call('files_close', current), -6); // Still protected by the current lease.
  assert.equal(call('files_read_finish', nextRead, 0, 0), 0);
  assert.equal(call('files_close', current), 0);
});
