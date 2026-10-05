// Generated IN/OUT cuts -> actual C provider. No JavaScript device emulation.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile]=process.argv.slice(2);
if (!compilerFile) throw new Error('usage: check-pic-provider.mjs VM.WASM COMPILER.WASM');
const memory=new WebAssembly.Memory({initial:8}), cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const cold=Buffer.from(cm.buffer), cv=new DataView(cm.buffer), input=cc.compiler_arena_min();
const output=input+8192, report=output+65536, entry=0x400000n;
const data=Buffer.from(memory.buffer), view=new DataView(memory.buffer), dir=vm.vm_arena_min();
const rows=dir+512, base=dir+4096, port=base+2048, segments=base+1408, code=base+24576, tss=base+28672;
const slot=vm.__indirect_function_table.grow(1), put=(at,v)=>view.setBigUint64(at,BigInt(v),true);
function reset() {
  data.fill(0,base);
  for (let i=0;i<6;++i) {
    const at=dir+i*32; put(at,i<4 ? (i+1)*4096 : (i+4)*4096);
    view.setUint32(at+8,(i+2)*4096,true); view.setUint32(at+12,3,true); view.setUint32(at+16,1,true);
    data.fill(0,at+20,at+32);
  }
  put(base+8192,0x2067); put(base+12288,0x3067); put(base+16384+16,0x4067);
  put(base+20480,0x8067); put(base+20488,0x9067);
  for (let r=0;r<16;++r) put(base+r*8,0xabcdef9887650000n+BigInt(r));
  put(base+384,entry); put(base+392,0x10202); put(base+400,0x80010011); put(base+408,0x1000);
  put(base+416,32); put(base+424,0x500); put(base+488,16); put(base+1128,42); put(port,9);
  view.setUint32(segments,2,true); view.setUint32(segments+36,0xa09b,true);
  put(segments+120,0x401000); view.setUint32(segments+128,4095,true); view.setUint32(segments+132,0x8b,true);
  view.setUint16(tss+102,104,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,6,6,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
}
const cuts=new Map();
async function compile(bytes) {
  const key=bytes.join(','); if (cuts.has(key)) return cuts.get(key);
  cold.fill(0,input,input+4096); cold.set(bytes,input);
  assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
  const emitted=cold.subarray(output,output+Number(cv.getBigUint64(report+40,true)));
  const cut=(await WebAssembly.instantiate(emitted,{machine:{memory,io:vm.vm_io}})).instance.exports.cut;
  cuts.set(key,cut); return cut;
}
let comparisons=0, faults=0;
async function run(coordinate,write,width,value,cpl=0,iopl=0,bit=-1,expectedByte=0) {
  let bytes=[];
  if (width===2) bytes.push(0x66);
  if (coordinate<=255) bytes.push(write ? width===1 ? 0xe6 : 0xe7 : width===1 ? 0xe4 : 0xe5,coordinate);
  else bytes.push(write ? width===1 ? 0xee : 0xef : width===1 ? 0xec : 0xed);
  const cut=await compile(bytes); vm.__indirect_function_table.set(slot,cut);
  data.fill(0,code,code+4096); data.set(bytes,code);
  put(base+384,entry); put(base,0xabcdef9843210000n|BigInt(value));
  put(base+16,0xabcdef9800000000n|BigInt(coordinate));
  put(base+488,16|cpl); put(base+392,0x10202|(iopl<<12));
  data.fill(0,tss+104,tss+4096);
  if (bit>=0) view.setUint16(tss+104+(coordinate>>3),1<<bit,true);
  put(rows,entry); view.setUint32(rows+8,bytes.length,true); view.setUint32(rows+12,1,true);
  view.setUint32(rows+16,slot,true); view.setUint32(rows+20,cv.getUint32(report+76,true),true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  const expected=Buffer.from(data.subarray(base,base+1256)), hidden=Buffer.from(data.subarray(segments,segments+136));
  const denied=cpl>iopl && bit>=0 && ((1<<bit) & (((1<<width)-1)<<(coordinate&7)));
  const result=denied ? 107n : width!==1 ? 6n : 1n;
  assert.equal(vm.vm_run(port,9n,1),result);
  if (result===1n) {
    expected.writeBigUInt64LE(entry+BigInt(bytes.length),384); expected.writeBigUInt64LE(expected.readBigUInt64LE(1128)+1n,1128);
    expected.writeBigUInt64LE(expected.readBigUInt64LE(392)&~0x10000n,392);
    if (!write) expected.writeBigUInt64LE((expected.readBigUInt64LE(0)&~255n)|BigInt(expectedByte),0);
    assert.equal(vm.vm_completed(),1); assert.equal(vm.vm_source_retired(),1n);
  } else {
    assert.equal(vm.vm_completed(),0); assert.equal(vm.vm_source_retired(),0n);
    if (denied) { assert.equal(view.getUint32(port+24,true),13); ++faults; }
  }
  assert(data.subarray(base,base+1256).equals(expected),'complete CPU after generated PIC cut');
  assert(data.subarray(segments,segments+136).equals(hidden)); ++comparisons;
}
for (const coordinate of [0x21,0xa1,0x4d0,0x4d1]) for (let value=0;value<256;++value) {
  reset(); await run(coordinate,true,1,value);
  await run(coordinate,false,1,0,0,0,-1,value&(coordinate===0x4d0 ? 0xf8 : coordinate===0x4d1 ? 0xde : 255));
}
for (const coordinate of [0x20,0x21,0xa0,0xa1,0x4d0,0x4d1])
for (let cpl=0;cpl<4;++cpl) for (let iopl=0;iopl<4;++iopl)
for (const width of [1,2,4]) for (let bit=0;bit<16;++bit) {
  reset(); await run(coordinate,true,width,255,cpl,iopl,bit);
}
reset(); await run(0xa1,true,1,255); vm.vm_close(); reset(); await run(0xa1,false,1,0);
vm.__indirect_function_table.set(slot,null); cc.compiler_close(); vm.vm_close();
console.log(JSON.stringify({format:'compiled-pic-c-provider-v1',status:'pass',modules:cuts.size,comparisons,faults,
  clockRequests:0,linuxBoot:'not-tested',irqDelivery:'not-tested',oracle:'C device plus complete compiled CPU/segment observations; QEMU qtest is a separate oracle'},null,2));
