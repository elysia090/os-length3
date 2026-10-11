// Independent C compiler borrows one/two physical fragments. Not Linux boot.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {CompilerOutput} from '../../src/v2/vm/check/browser/compiler-output.mjs';
const [providerFile,compilerFile]=process.argv.slice(2);
if (!providerFile || !compilerFile) throw new Error('usage: check-compiler-borrow.mjs VM.WASM COMPILER.WASM');
const memory=new WebAssembly.Memory({initial:64,maximum:128});
const vm=(await WebAssembly.instantiate(await readFile(providerFile),{machine:{memory}})).instance.exports;
const vmEnd=vm.vm_arena_min();
const low=new Uint8Array(memory.buffer,0,vmEnd).slice();
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory}})).instance.exports;
assert.equal(typeof cc.compiler_static_min,'function','relocated cold layout contract');
assert.equal(typeof cc.compiler_open_fragments,'function','generic borrowed-fragment input');
assert(vmEnd<=cc.compiler_static_min());
assert.deepEqual(new Uint8Array(memory.buffer,0,vmEnd),low,'compiler data initialization must not overwrite VM');
const input=cc.compiler_arena_min(),capacity=65536,output=input+32768,report=output+capacity;
const owner=new CompilerOutput(new Uint8Array(memory.buffer),output,capacity,report,memory);
const first=input+16384,second=input+8192,address=0x400000n,generation=9n;
let bytes=new Uint8Array(memory.buffer),view=new DataView(memory.buffer),parity=0,refusals=0;
const cases=[Uint8Array.of(0x90),Uint8Array.of(0x48,0xb8,1,2,3,4,5,6,7,8),
  Uint8Array.of(0x48,0x83,0xc0,1),Uint8Array.of(0x48,0x8b,0x00),Uint8Array.of(0xff,0xd0),
  Uint8Array.of(0x66,0x45,0x0f,0xd4,0xf7)];
function compare(source,at,count,limit) {
  bytes.fill(0x90,input,input+8192);bytes.set(source,input+at);
  assert.equal(cc.compiler_open_pages(input,count,address,generation),0);
  const baseline=owner.emit(()=>cc.compiler_emit(address+BigInt(at),limit,output,capacity,report));
  const expectedOutput=bytes.slice(output,output+capacity),expectedReport=bytes.slice(report,report+80);
  bytes.set(bytes.subarray(input,input+4096),first);
  bytes.set(bytes.subarray(input+4096,input+8192),second);
  const before=bytes.slice(input,output),beforeLow=bytes.slice(0,vmEnd);
  assert.equal(cc.compiler_open_fragments(first,second,count,address,generation),0);
  const status=owner.emit(()=>cc.compiler_emit(address+BigInt(at),limit,output,capacity,report));
  assert.equal(status,baseline);
  assert.deepEqual(bytes.subarray(output,output+capacity),expectedOutput);
  assert.deepEqual(bytes.subarray(report,report+80),expectedReport);
  assert.deepEqual(bytes.subarray(input,output),before,'borrowed source and arena gaps remain unchanged');
  assert.deepEqual(bytes.subarray(0,vmEnd),beforeLow,'cold C stack must not overwrite VM');
  status ? ++refusals : ++parity;
  return status;
}
for (let rank=0;rank<512;++rank) compare(cases[rank%cases.length],rank%32,1,1+rank%8);
assert.equal(compare(cases[1],4092,2,1),0);
assert.equal(compare(Uint8Array.of(0x48),4095,1,1),-105);
assert.equal(compare(Uint8Array.of(0x48,0x90),4095,2,1),0);
// UD2 is an intentional architectural fault body, not a grammar refusal.
assert.equal(compare(Uint8Array.of(0x0f,0x0b),0,1,1),0);
assert.equal(view.getBigUint64(report+24,true),1n);
assert.equal(view.getBigUint64(report+32,true),2n);
assert.equal(view.getUint32(report+60,true),4);
assert(WebAssembly.validate(bytes.subarray(output,output+Number(view.getBigUint64(report+40,true)))));
assert.equal(compare(cases[0],0,1,0),-100);
// Reversed and aliased physical slots are valid: virtual order alone matters.
bytes.fill(0x90,first,first+4096);
bytes[first+4095]=0x48;
assert.equal(cc.compiler_open_fragments(first,first,2,address,generation),0);
assert.equal(owner.emit(()=>cc.compiler_emit(address+4095n,1,output,capacity,report)),0);
assert.equal(view.getBigUint64(report+32,true),2n);
for (const args of [[first,second,0,address,generation],[first,second,3,address,generation],
  [first,second,1,address,0n],[first,second,1,address+1n,generation],
  [first,second,1,0xfffffffffffff000n,generation],
  [cc.compiler_static_min(),second,1,address,generation],
  [first,bytes.length-4095,2,address,generation]]) {
  const before=bytes.slice(output,report+80);
  assert.equal(cc.compiler_open_fragments(...args),-100);
  assert.equal(cc.compiler_emit(address,1,output,capacity,report),-100,'refused open closes previous source');
  assert.deepEqual(bytes.subarray(output,report+80),before);
}
assert.equal(cc.compiler_open_fragments(first,second,2,address,generation),0);
for (const target of [first,first+8,second,second+4090,input]) {
  const before=bytes.slice(input,report+80);
  assert.notEqual(cc.compiler_emit(address,1,target,capacity,report),0,'output reservation overlaps borrowed source');
  assert.deepEqual(bytes.subarray(input,report+80),before);
}
const beforeGrowth=bytes.slice(input,report+80),stats=owner.stats();
memory.grow(1);bytes=new Uint8Array(memory.buffer);view=new DataView(memory.buffer);owner.refresh();
assert.deepEqual(bytes.subarray(input,report+80),beforeGrowth);
assert.deepEqual(owner.stats(),stats,'grow neither poisons nor resets witness counters');
assert.equal(compare(cases[1],4092,2,1),0);
// A successful length declaration cannot hide a corrupt tail after grow.
bytes[output+60000]=1;memory.grow(1);owner.refresh();
assert.throws(()=>owner.emit(()=>-102),/refusal must not publish/);
assert.throws(()=>owner.refresh(),/failed compiler output/);
cc.compiler_close();
console.log(JSON.stringify({format:'compiler-borrowed-source-v1',status:'pass',linuxBoot:'not-tested',
  parity,refusals,physicalPayloadCopiesRequired:0,vmArenaEnd:vmEnd,compilerStaticMin:cc.compiler_static_min(),
  compilerArenaMin:input,memoryGrowthChecks:2,sourceOverlapChecks:5,output:owner.stats()},null,2));
