// Actual privileged x86 observations, joined to generated WRMSR/RDMSR cuts
// and the C MSR owner. QEMU differences are checked, not treated as the ISA.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,directory,traceFile]=process.argv.slice(2);
if (!traceFile) throw new Error('usage: check-msr-syscall-system.mjs VM.WASM CUT-DIRECTORY SYSTEM.TRACE');
const rows=(await readFile(traceFile,'utf8')).trim().split(/\r?\n/)
  .map(line=>line.trim().split(/\s+/).map(word=>BigInt(`0x${word}`)));
assert.equal(rows.length,288);
const boundary=[0n,1n,0x7fffffffffffn,0x800000000000n,0xffff7fffffffn<<16n|0xffffn,
  0xffff800000000000n,0xffffffffffffffffn,0x0023001000000000n];
const canonical=value=>value>>47n===0n || value>>47n===0x1ffffn;
const memory=new WebAssembly.Memory({initial:8});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cuts=await Promise.all([0,1].map(async rank=>(await WebAssembly.instantiate(
  await readFile(path.join(directory,`msr-${rank}.wasm`)),{machine:{memory,msr:vm.vm_msr}})).instance.exports.cut));
const data=Buffer.from(memory.buffer), view=new DataView(memory.buffer);
const dir=vm.vm_arena_min(), state=dir+4096, hidden=state+1408, port=state+2048;
const put=(at,value)=>view.setBigUint64(at,BigInt(value),true);
put(dir,0x1000n); view.setUint32(dir+8,4096,true); view.setUint32(dir+12,3,true); view.setUint32(dir+16,1,true);
let comparisons=0, matches=0, differences=0, faultMatches=0;
const differenceKinds={STAR:0,LSTAR:0,FMASK:0};
for (let index=0;index<rows.length;++index) {
  const row=rows[index], keyRank=Math.floor(index/72), inputRank=index%72;
  const value=inputRank<64 ? 1n<<BigInt(inputRank) : boundary[inputRank-64];
  assert.equal(row.length,12); assert.equal(row[0],BigInt(index)); assert.equal(row[1],1n);
  assert.equal(row[2],0xc0000081n+BigInt(keyRank)); assert.equal(row[3],value);
  assert.equal(row[8],row[11]); assert.equal(row[10],0n);
  const invalid=keyRank===0 ? !!(value&0xffffffffn) : keyRank===1 ? !canonical(value)
    : keyRank===3 ? !!(value>>32n) : false;
  const vector=invalid ? 13n : 0n;
  if (row[9]===vector) { ++matches; if (vector) ++faultMatches; }
  else {
    // The oracle accepts bits/addresses outside this Intel contract. Require
    // that exact known direction of disagreement and its complete readback.
    assert(invalid); assert.equal(row[9],0n);
    ++differences; ++differenceKinds[['STAR','LSTAR','CSTAR','FMASK'][keyRank]];
  }
  for (let k=0;k<4;++k) assert.equal(row[4+k],k===keyRank && !row[9] ? value : 0n);
  data.fill(0,state,state+4096); put(port,9n);
  put(state,0xdeadbeef00000000n|(value&0xffffffffn));
  put(state+16,0xdeadbeef00000000n|(value>>32n)); put(state+8,0xdeadbeef00000000n|row[2]);
  put(state+384,0x400000n); put(state+392,row[11]); put(state+400,0x80010011n);
  put(state+408,0x1000n); put(state+416,32n); put(state+424,0x500n); put(state+488,8n);
  view.setUint32(hidden,2,true); view.setUint32(hidden+36,0xa09b,true);
  assert.equal(vm.vm_open(state,data.length-state,4096,dir,1,1,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(state),0); assert.equal(vm.vm_bind_segments(hidden),0);
  const expected=Buffer.from(data.subarray(state,state+1256)), cache=Buffer.from(data.subarray(hidden,hidden+136));
  if (!invalid) {
    expected.writeUInt32LE(keyRank+3,608);
    for (let k=0;k<keyRank+3;++k) {
      expected.writeBigUInt64LE(BigInt(k===0 ? 0xc0000102 : k===1 ? 0x1a0 : 0xc0000081+k-2),616+k*8);
      expected.writeBigUInt64LE(k===1 ? 0x1801n : 0n,872+k*8);
    }
    expected.writeBigUInt64LE(value,888+keyRank*8); expected.writeBigUInt64LE(0x400002n,384);
    expected.writeBigUInt64LE(1n,1128);
  }
  assert.equal(cuts[0](state,port,0x400000n),invalid ? 107n : 1n);
  assert.deepEqual(data.subarray(state,state+1256),expected); assert.deepEqual(data.subarray(hidden,hidden+136),cache);
  if (invalid) { assert.equal(view.getUint32(port+24,true),13); assert.equal(view.getUint32(port+28,true),0); }
  ++comparisons;
  for (let k=0;k<4;++k) {
    put(state+384,0x400000n); put(state+8,0xdeadbeef00000000n|0xc0000081n+BigInt(k));
    const wanted=Buffer.from(data.subarray(state,state+1256));
    const readback=k===keyRank && !invalid ? value : 0n;
    wanted.writeBigUInt64LE(readback&0xffffffffn,0); wanted.writeBigUInt64LE(readback>>32n,16);
    wanted.writeBigUInt64LE(0x400002n,384); wanted.writeBigUInt64LE(wanted.readBigUInt64LE(1128)+1n,1128);
    assert.equal(cuts[1](state,port,0x400000n),1n); assert.deepEqual(data.subarray(state,state+1256),wanted);
    assert.deepEqual(data.subarray(hidden,hidden+136),cache); ++comparisons;
  }
  vm.vm_close();
}
console.log(JSON.stringify({format:'c-wasm-syscall-msr-system-v1',status:'pass',rows:rows.length,
  comparisons,nativeMatches:matches,faultMatches,knownOracleDifferences:differences,differenceKinds,
  oracle:'QEMU TCG CPL0, not physical hardware',
  reservationAndCanonicalFaults:'Intel SDM model when reference differs',
  syscallExecution:'not-tested',linuxBoot:'not-tested'},null,2));
