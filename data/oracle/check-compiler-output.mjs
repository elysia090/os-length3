// Exact diagnostic witness and real C emission parity; not Linux boot proof.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {CompilerOutput} from '../../src/v2/vm/check/browser/compiler-output.mjs';
const [compilerFile]=process.argv.slice(2);
if (!compilerFile) throw new Error('usage: check-compiler-output.mjs COMPILER.WASM');
const capacity=65536,output=64,report=output+capacity+16;
const bytes=new Uint8Array(report+80+16).fill(0x69),view=new DataView(bytes.buffer);
const owner=new CompilerOutput(bytes,output,capacity,report);
let expectedClears=0,expectedReports=0,lastLength=0;
for (let rank=0;rank<512;++rank) {
  expectedClears+=lastLength; if (lastLength) expectedReports+=80;
  const length=238+rank%23;
  assert.equal(owner.emit(()=>{
    assert(bytes.subarray(output,output+capacity).every(byte=>byte===0xa5));
    assert(bytes.subarray(report,report+80).every(byte=>byte===0xa5));
    bytes.fill(rank&255,output,output+length); bytes.fill(rank&255,report,report+80);
    view.setBigUint64(report+40,BigInt(length),true); return 0;
  }),0);
  assert(bytes.subarray(0,output).every(byte=>byte===0x69));
  assert(bytes.subarray(output+capacity,report).every(byte=>byte===0x69));
  assert(bytes.subarray(report+80).every(byte=>byte===0x69));
  lastLength=length;
}
expectedClears+=lastLength; expectedReports+=80;
for (const status of [-105,-102,-100]) assert.equal(owner.emit(()=>status),status);
assert.deepEqual(owner.stats(),{initialPoisonBytes:capacity+80,clearedModuleBytes:expectedClears,
  clearedReportBytes:expectedReports,emissions:515,refusalComparisons:3});
// A stray write beyond a successful declared extent must survive to the next
// refusal check. Re-poisoning full capacity would erase and hide this red.
const corrupt=new Uint8Array(65536+80),cv=new DataView(corrupt.buffer);
const bad=new CompilerOutput(corrupt,0,65536,65536);
assert.equal(bad.emit(()=>{cv.setBigUint64(65536+40,32n,true);corrupt[60000]=1;return 0;}),0);
assert.throws(()=>bad.emit(()=>-102),/refusal must not publish/);
assert.throws(()=>bad.emit(()=>0),/failed compiler output/);
for (const length of [0n,65537n]) {
  const data=new Uint8Array(65536+80),dv=new DataView(data.buffer);
  const invalid=new CompilerOutput(data,0,65536,65536);
  assert.throws(()=>invalid.emit(()=>{dv.setBigUint64(65536+40,length,true);return 0;}),/bounded compiler result/);
}
const failure=new CompilerOutput(new Uint8Array(65536+80),0,65536,65536);
assert.throws(()=>failure.emit(()=>{throw new Error('host trap');}),/host trap/);
assert.throws(()=>failure.emit(()=>0),/failed compiler output/);
const publication=new CompilerOutput(new Uint8Array(65536+80),0,65536,65536);
assert.throws(()=>publication.emit(()=>{publication.bytes[123]=1;return -105;}),/refusal must not publish/);
for (const fields of [[-1,65536,65536],[0,0,65536],[0,65537,65536],[0,65536,65535],[0,65536,65537]])
  assert.throws(()=>new CompilerOutput(new Uint8Array(131072),...fields),RangeError);
assert.throws(()=>new CompilerOutput(new Uint8Array(new SharedArrayBuffer(65536+80)),0,65536,65536),RangeError);

const memory=new WebAssembly.Memory({initial:32});
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory}})).instance.exports;
const cold=new Uint8Array(memory.buffer),rv=new DataView(memory.buffer),input=cc.compiler_arena_min();
const reference=input+8192,referenceReport=reference+capacity;
const candidate=referenceReport+4096,candidateReport=candidate+capacity;
const witness=new CompilerOutput(cold,candidate,capacity,candidateReport);
const cases=[Uint8Array.of(0x90),Uint8Array.of(0x48,0xb8,1,2,3,4,5,6,7,8),
  Uint8Array.of(0x48,0x83,0xc0,1),Uint8Array.of(0x0f,0xc8),Uint8Array.of(0xfa),
  Uint8Array.of(0xfb),Uint8Array.of(0x48,0x8b,0x00),Uint8Array.of(0xff,0xd0)];
let parity=0,refusals=0,previous=0,actualClears=0,actualReports=0;
function compare(source,at,limit,count=1) {
  cold.fill(0x90,input,input+8192); cold.set(source,input+at);
  assert.equal(cc.compiler_open_pages(input,count,0x400000n,9n),0);
  cold.fill(0xa5,reference,reference+capacity);cold.fill(0xa5,referenceReport,referenceReport+80);
  const baseline=cc.compiler_emit(0x400000n+BigInt(at),limit,reference,capacity,referenceReport);
  actualClears+=previous;if(previous)actualReports+=80;
  const status=witness.emit(()=>cc.compiler_emit(0x400000n+BigInt(at),limit,candidate,capacity,candidateReport));
  assert.equal(status,baseline);
  assert.deepEqual(cold.subarray(candidate,candidate+capacity),cold.subarray(reference,reference+capacity));
  assert.deepEqual(cold.subarray(candidateReport,candidateReport+80),cold.subarray(referenceReport,referenceReport+80));
  previous=status ? 0 : Number(rv.getBigUint64(candidateReport+40,true));
  if (status) ++refusals; else ++parity;
  return status;
}
try {
  for (let rank=0;rank<512;++rank) compare(cases[rank%cases.length],rank%16,1+rank%8);
  assert.equal(compare(Uint8Array.of(0x48),4095,1),-105); // Exact missing-tail refusal.
  assert.equal(compare(Uint8Array.of(0x48,0x90),4095,1,2),0); // Same source after real tail supply.
  assert.equal(compare(Uint8Array.of(0x0f,0x0b),0,1),-102); // Unsupported first instruction.
  assert.equal(compare(Uint8Array.of(0x90),0,0),-100); // Invalid bounded request.
} finally {cc.compiler_close();}
assert.equal(parity,513);assert.equal(refusals,3);
assert.equal(witness.stats().clearedModuleBytes,actualClears);
assert.equal(witness.stats().clearedReportBytes,actualReports);
console.log(JSON.stringify({format:'compiler-output-witness-v1',status:'pass',linuxBoot:'not-tested',
  fakeWitnessCases:515,realCParity:parity,realCRefusals:refusals,
  fullCapacityBytesAvoided:516*capacity-capacity-actualClears,output:witness.stats()},null,2));
