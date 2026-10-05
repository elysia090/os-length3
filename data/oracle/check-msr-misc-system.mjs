// QEMU TCG reference: legal MISC_ENABLE value transport and unchanged flags.
// TCG does not prove CPU-control side effects or reserved/readonly fault law.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [providerFile,directory,traceFile] = process.argv.slice(2);
if (!traceFile) throw new Error('usage: check-msr-misc-system.mjs VM.WASM CUT-DIRECTORY TRACE');
const trace = (await readFile(traceFile,'utf8')).trim().split(/\r?\n/)
  .map(line => line.trim().split(/\s+/).map(word => BigInt(`0x${word}`)));
assert.equal(trace.length,9);
trace.forEach((row,rank) => { assert.equal(row.length,9); assert.equal(row[0],BigInt(rank)); });
assert.equal(trace[0][4],1n,'independent fast-strings enabled reset');
const memory=new WebAssembly.Memory({initial:8}), data=Buffer.from(memory.buffer), view=new DataView(memory.buffer);
const provider=await WebAssembly.compile(await readFile(providerFile));
assert.deepEqual(WebAssembly.Module.imports(provider),[{module:'machine',name:'memory',kind:'memory'}]);
const vm=(await WebAssembly.instantiate(provider,{machine:{memory}})).exports;
const cuts=await Promise.all([0,1].map(async rank => (await WebAssembly.instantiate(
  await readFile(path.join(directory,`msr-${rank}.wasm`)),{machine:{memory,msr:vm.vm_msr}})).instance.exports.cut));
const directoryAt=vm.vm_arena_min(), state=directoryAt+4096, segments=state+1408, port=state+2048;
const put=(at,value)=>view.setBigUint64(at,BigInt(value),true);
put(directoryAt,0x1000); view.setUint32(directoryAt+8,4096,true);
view.setUint32(directoryAt+12,3,true); view.setUint32(directoryAt+16,1,true);
let comparisons=0;
try {
  for (const row of trace) {
    assert.equal(row[2],0x1a0n); assert.equal(row[3],row[4]); assert.equal(row[5],0x500n); assert.equal(row[8],0x202n);
    const bits=row[0] ? Number(row[0]-1n) : 1;
    const controls=BigInt(bits&1)|(bits&2 ? 1n<<22n : 0n)|(bits&4 ? 1n<<34n : 0n);
    assert.equal(row[4],controls);
    data.fill(0,state,state+4096); put(state+384,0x400000); put(state+392,0x202); put(state+400,0x80010011);
    put(state+408,0x1000); put(state+416,32); put(state+424,0x500); put(state+488,8); put(port,9);
    view.setUint32(segments,2,true); view.setUint32(segments+36,0xa09b,true);
    assert.equal(vm.vm_open(state,data.length-state,4096,directoryAt,1,1,directoryAt+1024,9n),0);
    assert.equal(vm.vm_bind_state(state),0); assert.equal(vm.vm_bind_segments(segments),0);
    if (row[0]) {
      put(state,(controls|0x1800n)&0xffffffffn); put(state+16,controls>>32n); put(state+8,0x1a0);
      const expected=Buffer.from(data.subarray(state,state+1256));
      expected.writeUInt32LE(2,608); expected.writeBigUInt64LE(0xc0000102n,616);
      expected.writeBigUInt64LE(0x1a0n,624); expected.writeBigUInt64LE(controls|0x1800n,880);
      expected.writeBigUInt64LE(0x400002n,384); expected.writeBigUInt64LE(1n,1128);
      assert.equal(cuts[0](state,port,0x400000n),1n); assert.deepEqual(data.subarray(state,state+1256),expected); ++comparisons;
    }
    put(state+384,0x400000); put(state+8,0x1a0); put(state,0xdeadbeef00000000n); put(state+16,0xdeadbeef00000000n);
    const expected=Buffer.from(data.subarray(state,state+1256));
    expected.writeBigUInt64LE((row[4]|0x1800n)&0xffffffffn,0); expected.writeBigUInt64LE(row[4]>>32n,16);
    expected.writeBigUInt64LE(0x400002n,384); expected.writeBigUInt64LE(row[0] ? 2n : 1n,1128);
    assert.equal(cuts[1](state,port,0x400000n),1n); assert.deepEqual(data.subarray(state,state+1256),expected); ++comparisons;
    vm.vm_close();
  }
} finally { vm.vm_close(); }
console.log(JSON.stringify({format:'c-wasm-misc-system-oracle-v1',status:'pass',rows:trace.length,comparisons,
  oracle:'QEMU TCG legal value transport / fast-strings reset / flags only, not physical hardware',
  projection:'TCG has status bits 11/12 clear; declared CPU has unavailable BTS/PEBS set. Compare controls with this explicit status projection.',
  controlSideEffects:'Intel SDM literal-model checks, not proved by this TCG trace',
  referenceCpuid:trace.map(row=>({controls:row[4].toString(16),maximum:row[6].toString(16),nx:!!(row[7]&(1n<<20n))})),
  faultCoverage:'model only; readonly/NXE write refusals still explicit',linuxBoot:'not-tested'},null,2));
