// Generated one-instruction cuts -> actual C provider, never a JS MSR backend.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [providerFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-msr.mjs VM.WASM CODE-CUT-DIRECTORY');
const provider = await WebAssembly.compile(await readFile(providerFile));
assert.deepEqual(WebAssembly.Module.imports(provider),[{module:'machine',name:'memory',kind:'memory'}]);
const keys = [0xc0000080,0xc0000100,0xc0000101,0xc0000102,
  0xc0000081,0xc0000082,0xc0000083,0xc0000084,0,0xffffffff,0x1234];
const values = Array.from({length:64},(_,bit) => 1n << BigInt(bit));
values.push(0n,1n,0x7fffffffffffn,0x800000000000n,0xffff7fffffffffffn,0xffff800000000000n,0xffffffffffffffffn,
  0x100n,0x500n,0x900n,0xd01n);
const canonical = value => value >> 47n === 0n || value >> 47n === 0x1ffffn;
let comparisons = 0, dispatches = 0;
for (let rank = 0; rank < 3; ++rank) {
  const prefix = path.join(directory,`msr-${rank}`), meta = JSON.parse(await readFile(`${prefix}.json`));
  const module = await WebAssembly.compile(await readFile(`${prefix}.wasm`));
  assert.deepEqual(WebAssembly.Module.imports(module),[
    {module:'machine',name:'memory',kind:'memory'},{module:'machine',name:'msr',kind:'function'}]);
  const memory = new WebAssembly.Memory({initial:8});
  const vm = (await WebAssembly.instantiate(provider,{machine:{memory}})).exports;
  const cut = (await WebAssembly.instantiate(module,{machine:{memory,msr:vm.vm_msr}})).exports.cut;
  const view = new DataView(memory.buffer), bytes = Buffer.from(memory.buffer);
  const directoryAt = vm.vm_arena_min(), rows = directoryAt + 512;
  const state = directoryAt + 4096, segments = state + 1408, port = state + 2048;
  const put = (at,value) => view.setBigUint64(at,BigInt(value),true);
  for (let i = 0; i < 5; ++i) {
    const at = directoryAt + i*32; put(at,i < 4 ? (i+1)*4096 : 0x8000);
    view.setUint32(at+8,(i+2)*4096,true); view.setUint32(at+12,3,true); view.setUint32(at+16,1,true);
  }
  const entry = BigInt(meta.entry);
  for (let i = 0; i < 4; ++i)
    put(state+(i+2)*4096+Number((entry >> [39n,30n,21n,12n][i]) & 511n)*8,
      BigInt(i === 3 ? 0x8000 : (i+2)*4096) | 103n);
  bytes.set(await readFile(`${prefix}.source-page`),state+24576);
  const table = vm.__indirect_function_table, slot = table.grow(1); table.set(slot,cut);
  put(rows,entry); view.setUint32(rows+8,meta.sourceBytes,true);
  view.setUint32(rows+12,1,true); view.setUint32(rows+16,slot,true);
  function reset(cpl,key,value) {
    bytes.fill(0,state,state+4096);
    for (let reg = 0; reg < 16; ++reg) put(state+reg*8,0xabcdef0100000000n + BigInt(reg));
    put(state,(value & 0xffffffffn) | 0xdeadbeef00000000n);
    put(state+8,BigInt(key) | 0xdeadbeef00000000n);
    put(state+16,(value >> 32n) | 0xabcdef0100000000n);
    put(state+384,entry); put(state+392,0x10202); put(state+400,0x80010011); put(state+408,0x1000);
    put(state+416,32); put(state+424,0x500); put(state+488,16|cpl); put(state+1128,42);
    view.setUint32(segments,2,true); view.setUint32(segments+36,0xa09b,true);
    put(segments+72,0x123456); put(segments+88,0xffff800012340000n);
    view.setUint32(segments+84,0x10000,true); view.setUint32(segments+100,0xc093,true);
    put(port,9);
    assert.equal(vm.vm_open(state,bytes.length-state,4096,directoryAt,5,5,directoryAt+1024,9n),0);
    assert.equal(vm.vm_bind_state(state),0); assert.equal(vm.vm_bind_segments(segments),0);
  }
  for (let cpl = 0; cpl < 4; ++cpl) for (const key of keys) for (let value of values) {
    if (rank !== 0 && value !== 0n) continue; // READ/SWAP have no value operand.
    if (key === keys[0] && value !== 0n) value |= 0x100n;
    reset(cpl,key,value);
    const unknown = !keys.slice(0,8).includes(key);
    const invalid = cpl !== 0 || (rank !== 2 && unknown) || (rank === 0 &&
      (key === keys[0] ? !!(value & ~0xd01n) || !(value & 0x100n)
        : key === keys[4] ? !!(value&0xffffffffn) : key === keys[6] ? false
        : key === keys[7] ? !!(value>>32n) : !canonical(value)));
    const expected = Buffer.from(bytes.subarray(state,state+1256));
    const hidden = Buffer.from(bytes.subarray(segments,segments+136));
    if (!invalid) {
      if (rank === 0) {
        if (key === keys[0]) expected.writeBigUInt64LE((value & ~0x400n) | 0x400n,424);
        else if (key === keys[1] || key === keys[2]) hidden.writeBigUInt64LE(value,key === keys[1] ? 72 : 88);
        else if (key===keys[3]) { expected.writeUInt32LE(1,608); expected.writeBigUInt64LE(BigInt(key),616); expected.writeBigUInt64LE(value,872); }
        else {
          const owner=key-0xc0000081+2;
          expected.writeUInt32LE(owner+1,608);
          for (let i=0;i<=owner;++i) {
            expected.writeBigUInt64LE(BigInt(i===0 ? 0xc0000102 : i===1 ? 0x1a0 : 0xc0000081+i-2),616+i*8);
            expected.writeBigUInt64LE(i===1 ? 0x1801n : 0n,872+i*8);
          }
          expected.writeBigUInt64LE(value,872+owner*8);
        }
      } else if (rank === 1) {
        const read = key === keys[0] ? 0x500n : key === keys[1] ? 0x123456n : key === keys[2] ? 0xffff800012340000n : 0n;
        expected.writeBigUInt64LE(read & 0xffffffffn,0); expected.writeBigUInt64LE(read >> 32n,16);
      } else {
        expected.writeUInt32LE(1,608); expected.writeBigUInt64LE(0xc0000102n,616);
        expected.writeBigUInt64LE(0xffff800012340000n,872); hidden.writeBigUInt64LE(0n,88);
      }
      expected.writeBigUInt64LE(0x202n,392); expected.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);
      expected.writeBigUInt64LE(43n,1128);
    }
    assert.equal(cut(state,port),invalid ? 107n : 1n,`${rank} key ${key.toString(16)} value ${value.toString(16)} CPL ${cpl}`);
    assert.deepEqual(bytes.subarray(state,state+1256),expected); assert.deepEqual(bytes.subarray(segments,segments+136),hidden);
    if (invalid) {
      assert.equal(view.getBigUint64(port+16,true),entry); assert.equal(view.getUint32(port+24,true),13);
      assert.equal(view.getUint32(port+28,true),0);
    }
    ++comparisons;
  }
  reset(0,keys[0],0x500n); assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  assert.equal(vm.vm_run(port,9n,1),rank === 0 ? 5n : 1n);
  assert.equal(vm.vm_completed(),1); assert.equal(vm.vm_source_retired(),1n); ++dispatches;
  for (const badPort of [state,segments,port+1,0xfffffff8]) {
    reset(0,keys[2],0n); const before = Buffer.from(bytes.subarray(state,state+4096));
    assert.equal(cut(state,badPort),6n); assert.deepEqual(bytes.subarray(state,state+4096),before);
  }
  reset(0,keys[2],0n); put(port,8); const before = Buffer.from(bytes.subarray(state,state+4096));
  assert.equal(cut(state,port),5n); assert.deepEqual(bytes.subarray(state,state+4096),before);
  reset(0,keys[2],0n); assert.equal(vm.vm_reserve(port,entry,8,3),0n);
  assert.equal(vm.vm_msr(port,0,0xffffffff,0n),107n); assert.equal(vm.vm_commit(port,0n),6n);
  if (rank !== 2) for (const key of [0x10]) {
    reset(0,key,0n); const before = Buffer.from(bytes.subarray(state,state+4096));
    assert.equal(cut(state,port),6n); assert.deepEqual(bytes.subarray(state,state+4096),before);
    assert.equal(view.getUint32(port+24,true),0,'known but unimplemented is not an invented exception');
  }
  if (rank !== 2) {
    for (let cpl=0;cpl<4;++cpl) for (let bits=0;bits<8;++bits) {
      const value=0x1800n|BigInt(bits&1)|(bits&2 ? 1n<<22n : 0n)|(bits&4 ? 1n<<34n : 0n);
      reset(cpl,0x1a0,value);
      // Retain a preexisting inactive GS owner while installing rank 1.
      view.setUint32(state+608,1,true); put(state+616,0xc0000102); put(state+872,0x42);
      const expected=Buffer.from(bytes.subarray(state,state+1256));
      const hidden=Buffer.from(bytes.subarray(segments,segments+136));
      if (!cpl) {
        if (!rank) {
          expected.writeUInt32LE(2,608); expected.writeBigUInt64LE(0x1a0n,624); expected.writeBigUInt64LE(value,880);
        } else {
          expected.writeBigUInt64LE(0x1801n,0); expected.writeBigUInt64LE(0n,16);
        }
        expected.writeBigUInt64LE(0x202n,392); expected.writeBigUInt64LE(entry+2n,384);
        expected.writeBigUInt64LE(43n,1128);
      }
      assert.equal(cut(state,port),cpl ? 107n : 1n); assert.deepEqual(bytes.subarray(state,state+1256),expected);
      assert.deepEqual(bytes.subarray(segments,segments+136),hidden); ++comparisons;
    }
    reset(0,0x1a0,0x1801n); assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    assert.equal(vm.vm_run(port,9n,1),rank ? 1n : 5n);
    assert.equal(vm.vm_completed(),1); assert.equal(vm.vm_source_retired(),1n); ++dispatches;
    if (!rank) for (let bit=0;bit<64;++bit) {
      if ([0,22,34].includes(bit)) continue;
      reset(0,0x1a0,0x1801n^(1n<<BigInt(bit))); const before=Buffer.from(bytes.subarray(state,state+4096));
      assert.equal(cut(state,port),bit === 11 || bit === 12 ? 6n : 107n);
      assert.deepEqual(bytes.subarray(state,state+1256),before.subarray(0,1256));
      assert.deepEqual(bytes.subarray(segments,segments+136),before.subarray(1408,1544));
      if (bit === 11 || bit === 12) assert.equal(view.getUint32(port+24,true),0);
      else {
        assert.equal(view.getBigUint64(port+16,true),entry); assert.equal(view.getUint32(port+24,true),13);
        assert.equal(view.getUint32(port+28,true),0);
      }
      ++comparisons;
    }
  }
  table.set(slot,null); vm.vm_close();
}
console.log(JSON.stringify({format:'c-wasm-msr-model-v1',status:'pass',comparisons,dispatches,
  linuxBoot:'not-tested',oracle:'Intel SDM model, not system-mode execution'},null,2));
