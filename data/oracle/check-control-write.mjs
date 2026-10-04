// Intel SDM model -> generated cut -> actual C-Wasm control boundary.
// Not a host opcode interpreter or hardware exception-delivery oracle.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
const [providerFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-control-write.mjs VM.WASM CONTROL-FIXTURE-DIRECTORY');
const provider = await WebAssembly.compile(await readFile(providerFile));
assert.deepEqual(WebAssembly.Module.imports(provider),[{module:'machine',name:'memory',kind:'memory'}]);
const offsets = {0:400,2:432,3:408,4:416,8:440};
const names = (await readdir(directory)).filter(name => /^control-write-\d+-\d+\.json$/.test(name));
assert.equal(names.length,80);
let cases = 0;
for (const name of names) {
  const prefix = path.join(directory,name.slice(0,-5)), meta = JSON.parse(await readFile(`${prefix}.json`));
  const module = await WebAssembly.compile(await readFile(`${prefix}.wasm`));
  assert.deepEqual(WebAssembly.Module.imports(module),[
    {module:'machine',name:'memory',kind:'memory'}, {module:'machine',name:'control',kind:'function'}]);
  const memory = new WebAssembly.Memory({initial:8});
  const vm = (await WebAssembly.instantiate(provider,{machine:{memory}})).exports;
  const cut = (await WebAssembly.instantiate(module,{machine:{memory,control:vm.vm_control}})).exports.cut;
  const view = new DataView(memory.buffer), bytes = Buffer.from(memory.buffer);
  const directoryOffset = vm.vm_arena_min(), rows = directoryOffset + 512;
  const state = directoryOffset + 4096, segments = state + 1408, port = state + 2048;
  // Four-level translation of the fixed source page, with A/D already set.
  for (let i = 0; i < 5; ++i) {
    const at = directoryOffset + i * 32;
    view.setBigUint64(at,BigInt(i < 4 ? (i + 1) * 4096 : 0x8000),true);
    view.setUint32(at + 8,(i + 2) * 4096,true); view.setUint32(at + 12,3,true);
    view.setUint32(at + 16,1,true);
  }
  const entry = BigInt(meta.entry), shifts = [39n,30n,21n,12n];
  for (let i = 0; i < 4; ++i)
    view.setBigUint64(state + (i + 2) * 4096 + Number((entry >> shifts[i]) & 511n) * 8,
      BigInt(i === 3 ? 0x8000 : (i + 2) * 4096) | 103n,true);
  bytes.set(await readFile(`${prefix}.source-page`),state + 24576);
  const table = vm.__indirect_function_table, slot = table.grow(1); table.set(slot,cut);
  view.setBigUint64(rows,entry,true); view.setUint32(rows + 8,meta.sourceBytes,true);
  view.setUint32(rows + 12,1,true); view.setUint32(rows + 16,slot,true);
  function reset(cpl,value) {
    bytes.fill(0,state,state + 4096);
    for (let reg = 0; reg < 16; ++reg) view.setBigUint64(state + reg * 8,0x12340000n + BigInt(reg),true);
    view.setBigUint64(state + meta.reg * 8,value,true);
    view.setBigUint64(state + 384,entry,true); view.setBigUint64(state + 392,0x202n,true);
    view.setBigUint64(state + 400,0x80010011n,true); view.setBigUint64(state + 408,0x1000n,true);
    view.setBigUint64(state + 416,32n,true); view.setBigUint64(state + 424,0x500n,true);
    view.setBigUint64(state + 488,16n | BigInt(cpl),true); view.setBigUint64(state + 1128,42n,true);
    view.setUint32(segments,2,true); view.setUint32(segments + 8 + 16 + 12,0xa09b,true);
    view.setBigUint64(port,9n,true);
    assert.equal(vm.vm_open(state,bytes.length - state,4096,directoryOffset,5,5,directoryOffset + 1024,9n),0);
    assert.equal(vm.vm_bind_state(state),0); assert.equal(vm.vm_bind_segments(segments),0);
  }
  const values = Array.from({length:64},(_,bit) => 1n << BigInt(bit));
  values.push(0n,0x80000001n,0xffffffffn,0x60000000n,0x8000000000000001n,0x12345fffn,15n,32n,0x7b4n);
  for (let cpl = 0; cpl < 4; ++cpl) for (let value of values) {
    // Exercise all high bits while retaining the long-mode mandatory bits.
    if (meta.control === 0) value |= 0x80000001n;
    if (meta.control === 4) value |= 32n;
    reset(cpl,value);
    if (value & 1n) view.setBigUint64(state + 392,0x10202n,true);
    let invalid = cpl !== 0, normalized = value;
    if (meta.control === 0) {
      invalid ||= value > 0xffffffffn || (value & 0x60000000n) === 0x20000000n;
      normalized = (value & 0xe005003fn) | 16n;
    } else if (meta.control === 3) {
      invalid ||= value >= 1n << 40n; normalized &= ~0xfe7n;
    } else if (meta.control === 4) invalid ||= !!(value & ~0x7b4n);
    else if (meta.control === 8) invalid ||= value > 15n;
    const expected = Buffer.from(bytes.subarray(state,state + 1256));
    const hidden = Buffer.from(bytes.subarray(segments,segments + 136));
    if (!invalid) {
      expected.writeBigUInt64LE(normalized,offsets[meta.control]);
      expected.writeBigUInt64LE(0x202n,392);
      expected.writeBigUInt64LE(entry + BigInt(meta.sourceBytes),384); expected.writeBigUInt64LE(43n,1128);
    }
    assert.equal(cut(state,port),invalid ? 107n : 1n,`${name}: value ${value.toString(16)} CPL ${cpl}`);
    assert.deepEqual(bytes.subarray(state,state + 1256),expected); assert.deepEqual(bytes.subarray(segments,segments + 136),hidden);
    if (invalid) {
      assert.equal(view.getBigUint64(port + 16,true),entry);
      assert.equal(view.getUint32(port + 24,true),13); assert.equal(view.getUint32(port + 28,true),0);
    }
    ++cases;
  }
  reset(0,meta.control === 0 ? 0x80010011n : meta.control === 3 ? 0x1000n : meta.control === 4 ? 32n : 0n);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  assert.equal(vm.vm_run(port,9n,1),5n,'even an equal-value control write revokes the following fetch admission');
  assert.equal(vm.vm_completed(),1); assert.equal(vm.vm_source_retired(),1n);
  assert.equal(view.getBigUint64(state + 1128,true),43n);
  assert.equal(vm.vm_run(port,9n,1),5n); assert.equal(vm.vm_completed(),0);
  reset(0,32n); view.setBigUint64(port,8n,true);
  let before = Buffer.from(bytes.subarray(state,state + 1256));
  assert.equal(cut(state,port),5n); assert.deepEqual(bytes.subarray(state,state + 1256),before);
  for (const badPort of [state,segments,port + 1,0xfffffff8]) {
    reset(0,32n); before = Buffer.from(bytes.subarray(state,state + 1256));
    assert.equal(cut(state,badPort),6n); assert.deepEqual(bytes.subarray(state,state + 1256),before);
  }
  for (const flag of [0x100n,0x20000n]) {
    reset(0,32n); view.setBigUint64(state + 392,flag | 2n,true);
    before = Buffer.from(bytes.subarray(state,state + 1256));
    assert.equal(cut(state,port),6n); assert.deepEqual(bytes.subarray(state,state + 1256),before);
  }
  // A failed control write consumes a preceding RMW reservation as well.
  reset(0,32n); assert.equal(vm.vm_reserve(port,entry,8,3),0n);
  assert.equal(vm.vm_control(port,4,0n),107n);
  assert.equal(vm.vm_commit(port,0n),6n);
  table.set(slot,null); vm.vm_close();
}
console.log(`Compiled control writes / C-Wasm: ${names.length} modules / ${cases} model cases green; equal-write revoke, stale, aliases, flags and reservation cancellation; NOT Linux boot`);
