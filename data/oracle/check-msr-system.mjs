// Actual QEMU TCG legal MSR results vs generated cuts and the C provider.
// Privilege/reserved/noncanonical faults are NOT proved by this trace.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [providerFile,directory,traceFile] = process.argv.slice(2);
if (!traceFile) throw new Error('usage: check-msr-system.mjs VM.WASM CUT-DIRECTORY TRACE');
const trace = (await readFile(traceFile,'utf8')).trim().split(/\r?\n/)
  .map(line => line.trim().split(/\s+/).map(word => BigInt(`0x${word}`)));
assert.equal(trace.length,32); trace.forEach((row,rank) => { assert.equal(row.length,9); assert.equal(row[0],BigInt(rank)); });
const memory = new WebAssembly.Memory({initial:8});
const provider = await WebAssembly.compile(await readFile(providerFile));
assert.deepEqual(WebAssembly.Module.imports(provider),[{module:'machine',name:'memory',kind:'memory'}]);
const vm = (await WebAssembly.instantiate(provider,{machine:{memory}})).exports;
const cuts = await Promise.all([0,1,2].map(async rank =>
  (await WebAssembly.instantiate(await readFile(path.join(directory,`msr-${rank}.wasm`)),
    {machine:{memory,msr:vm.vm_msr}})).instance.exports.cut));
const view = new DataView(memory.buffer), bytes = Buffer.from(memory.buffer);
const directoryAt = vm.vm_arena_min(), state = directoryAt+4096, segments = state+1408, port = state+2048;
view.setBigUint64(directoryAt,0x1000n,true); view.setUint32(directoryAt+8,4096,true);
view.setUint32(directoryAt+12,3,true); view.setUint32(directoryAt+16,1,true);
const put = (at,value) => view.setBigUint64(at,BigInt(value),true);
let comparisons = 0;
for (const row of trace) {
  bytes.fill(0,state,state+4096);
  put(state+392,0x202); put(state+400,0x80010011); put(state+408,0x1000); put(state+416,32); put(state+424,0x500);
  put(state+488,8); view.setUint32(state+608,1,true); put(state+616,0xc0000102); put(state+872,0x11112222);
  view.setUint32(segments,2,true); view.setUint32(segments+36,0xa09b,true);
  put(segments+72,0x123456); put(segments+88,0xffff800012340000n); put(port,9);
  assert.equal(vm.vm_open(state,bytes.length-state,4096,directoryAt,1,1,directoryAt+1024,9n),0);
  assert.equal(vm.vm_bind_state(state),0); assert.equal(vm.vm_bind_segments(segments),0);
  put(state+384,0x400000); put(state,(row[3] & 0xffffffffn) | 0xdeadbeef00000000n);
  put(state+16,(row[3] >> 32n) | 0xdeadbeef00000000n); put(state+8,row[2] | 0xdeadbeef00000000n);
  const expected = Buffer.from(bytes.subarray(state,state+1256)), hidden = Buffer.from(bytes.subarray(segments,segments+136));
  hidden.writeBigUInt64LE(row[4],72); hidden.writeBigUInt64LE(row[5],88);
  expected.writeBigUInt64LE(row[6],872); expected.writeBigUInt64LE(row[7],424);
  expected.writeBigUInt64LE(row[8],392); expected.writeBigUInt64LE(row[1] === 1n ? 0x400002n : 0x400003n,384);
  expected.writeBigUInt64LE(1n,1128);
  assert.equal(cuts[row[1] === 1n ? 0 : 2](state,port),1n);
  assert.deepEqual(bytes.subarray(state,state+1256),expected); assert.deepEqual(bytes.subarray(segments,segments+136),hidden);
  for (let rank = 0; rank < 4; ++rank) {
    const key = rank === 3 ? 0xc0000080 : 0xc0000100+rank, value = row[4+rank];
    put(state+384,0x400000); put(state+8,BigInt(key) | 0xabcdef0100000000n);
    put(state,0xdeadbeef00000000n); put(state+16,0xdeadbeef00000000n);
    const before = Buffer.from(bytes.subarray(state,state+1256));
    before.writeBigUInt64LE(value & 0xffffffffn,0); before.writeBigUInt64LE(value >> 32n,16);
    before.writeBigUInt64LE(0x400002n,384); before.writeBigUInt64LE(BigInt(rank+2),1128);
    assert.equal(cuts[1](state,port),1n); assert.deepEqual(bytes.subarray(state,state+1256),before);
    assert.deepEqual(bytes.subarray(segments,segments+136),hidden); ++comparisons;
  }
  ++comparisons; vm.vm_close();
}
console.log(JSON.stringify({format:'c-wasm-msr-system-oracle-v1',status:'pass',rows:32,comparisons,
  oracle:'QEMU TCG legal CPL0 MSR/EFER/SWAPGS, not physical hardware',
  faultCoverage:'separate Intel SDM model only',linuxBoot:'not-tested'},null,2));
