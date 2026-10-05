// Execute the emitted functions in the actual C provider/MMU/dispatcher.
// JavaScript supplies inputs and comparisons, never a guest operation.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {seedDisabledDebug} from './machine-observation.mjs';
const [vmFile,compilerFile,directory,traceFile]=process.argv.slice(2);
if (!traceFile) throw new Error('usage: check-system-segments.mjs VM.WASM COMPILER.WASM FIXTURES SYSTEM.TRACE');
const memory=new WebAssembly.Memory({initial:8,maximum:16}), cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const data=Buffer.from(memory.buffer), view=new DataView(memory.buffer), cold=Buffer.from(cm.buffer), cv=new DataView(cm.buffer);
const ci=cc.compiler_arena_min(), co=ci+8192, cr=co+65536;
const input=vm.vm_arena_min(), dir=input+8192, rows=dir+512, branches=input+12288, base=input+16384;
const state=base, hidden=base+1408, port=base+2048, request=base+2176, first=base+28672, second=base+32768;
const entry=0x400000n, slot=vm.__indirect_function_table.grow(1);
const put=(at,value)=>view.setBigUint64(at,BigInt(value),true), dw=(at,value)=>view.setUint32(at,value,true);
let parity=0, models=0, native=0, knownOracleDifferences=0, waits=0;
const fixtures=[];
function reset(source,meta,{cpl=0,selector=24,low=0x1234n|BigInt(meta.task ? 0x89 : 0x82)<<40n,high=0n,
  offset=1024,limit=39,protection=0,resident=true,sourceOffset=128,flags=0x8d7n}={}) {
  data.fill(0,input,input+8192); data[input+0x1f1]=31; data[input+0x200]=0xeb; data[input+0x201]=0x6a;
  view.setUint16(input+0x1fe,0xaa55,true); dw(input+0x202,0x53726448); view.setUint16(input+0x206,0x20f,true);
  data[input+0x211]=1; data[input+0x236]=1; dw(input+0x1f4,0x2e640); dw(input+0x230,0x200000);
  put(input+0x258,0x1000000); dw(input+0x260,0xe62000); dw(input+0x22c,0x37ffffff); dw(input+0x238,2047);
  assert.equal(vm.vm_boot_prepare(input,4096,0x2ea400n,0x65432n,0x8000000n,input+4096,0),0);
  data.fill(0,base); data.fill(0,dir,dir+1024);
  for (let i=0;i<(resident ? 6 : 5);++i) {
    const at=dir+i*32; put(at,i<4 ? (i+1)*4096 : (i+4)*4096);
    dw(at+8,i<4 ? (i+2)*4096 : i===4 ? first-base : second-base); dw(at+12,3); dw(at+16,1);
  }
  put(base+8192,0x2067); put(base+12288,0x3067); put(base+16384+16,0x4067);
  put(base+20480,0x8067); put(base+20488,protection===1 ? 0 : protection===2 ? 0x9065 : 0x9067);
  data.fill(0xa5,first,second+4096); data.set(source.subarray(0,16),first);
  put(first+offset,low); put(first+offset+8,high);
  data.fill(0x93,state,state+1256);
  seedDisabledDebug(view, state);
  for (let reg=0;reg<16;++reg) put(state+reg*8,0xabcdeffedcba0000n|BigInt(selector));
  if (meta.memory) {
    const address=meta.form===3 ? entry+BigInt(meta.sourceBytes+512) : entry+BigInt(sourceOffset);
    put(state+56,address); put(state+32,address-14n); put(state+96,address-18n); put(state+8,1);
    if (meta.address32) for (const reg of [7,4,12]) put(state+reg*8,view.getBigUint64(state+reg*8,true)|0xdeadbeef00000000n);
    view.setUint16(first+Number(address-entry),selector,true);
  }
  put(state+384,entry); put(state+392,flags); put(state+400,0x80010011); put(state+408,0x1000);
  put(state+416,32); put(state+424,0xd00); put(state+488,8|cpl); put(state+1128,42);
  put(state+448,entry+BigInt(offset-24)); put(state+456,limit); put(port,9);
  dw(hidden,2); dw(hidden+36,0xa09b|(cpl<<5));
  for (const rank of [6,7]) { put(hidden+8+rank*16,0xabcdef); dw(hidden+16+rank*16,123); dw(hidden+20+rank*16,0x10000); }
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,resident ? 6 : 5,8,branches,9n),0);
  assert.equal(vm.vm_bind_state(state),0); assert.equal(vm.vm_bind_segments(hidden),0);
  put(rows,entry); dw(rows+8,meta.sourceBytes); dw(rows+12,1); dw(rows+16,slot); dw(rows+20,meta.operandBinding);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
function compare(meta,selector,vector,error,offset=1024) {
  const cpu=Buffer.from(data.subarray(state,state+1256)), cache=Buffer.from(data.subarray(hidden,hidden+136));
  const payload=Buffer.from(data.subarray(first,second+4096)), rank=6+meta.task;
  const low=payload.readBigUInt64LE(offset), high=payload.readBigUInt64LE(offset+8);
  if (!vector) {
    cpu.writeBigUInt64LE(BigInt(selector),432+(6+rank)*8); cpu.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);
    cpu.writeBigUInt64LE(cpu.readBigUInt64LE(392)&~0x10000n,392); cpu.writeBigUInt64LE(43n,1128);
    if (selector<4) { cache.writeBigUInt64LE(0n,8+rank*16); cache.writeUInt32LE(0,16+rank*16); cache.writeUInt32LE(0x10000,20+rank*16); }
    else {
      const baseAddress=((low>>16n)&0xffffffn)|((low>>32n)&0xff000000n)|((high&0xffffffffn)<<32n);
      let limit=Number((low&0xffffn)|((low>>32n)&0xf0000n)), attr=Number(((low>>40n)&0xffn)|((low>>40n)&0xf000n));
      if (attr&0x8000) limit=limit*4096+4095;
      cache.writeBigUInt64LE(baseAddress,8+rank*16); cache.writeUInt32LE(limit,16+rank*16);
      cache.writeUInt32LE(attr|(meta.task ? 2 : 0),20+rank*16);
      if (meta.task) payload[offset+5]|=2;
    }
  }
  assert.equal(vm.vm_run(port,9n,1),vector ? BigInt(vector*8+3) : meta.task && selector>=4 ? 5n : 1n);
  assert.deepEqual(data.subarray(state,state+1256),cpu); assert.deepEqual(data.subarray(hidden,hidden+136),cache);
  assert.deepEqual(data.subarray(first,second+4096),payload);
  assert.equal(vm.vm_completed(),vector ? 0 : 1); assert.equal(vm.vm_source_retired(),vector ? 0n : 1n);
  if (vector) { assert.equal(view.getUint32(port+24,true),vector); assert.equal(view.getUint32(port+28,true),error); }
}
for (let index=0;index<144;++index) {
  const prefix=path.join(directory,`segment-${index}`), meta=JSON.parse(await readFile(`${prefix}.json`));
  const source=await readFile(`${prefix}.source-page`), code=await readFile(`${prefix}.wasm`);
  cold.set(source,ci); assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0); assert.equal(cv.getBigUint64(cr+40,true),BigInt(code.length));
  assert(cold.subarray(co,co+code.length).equals(code)); ++parity;
  meta.operandBinding=cv.getUint32(cr+76,true);
  const module=await WebAssembly.compile(code);
  assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'},
    ...(meta.memory ? [{module:'machine',name:'access',kind:'function'}] : []),{module:'machine',name:'segment',kind:'function'}]);
  const cut=(await WebAssembly.instantiate(module,{machine:{memory,access:vm.vm_access,segment:vm.vm_segment}})).exports.cut;
  fixtures.push({meta,source,cut}); vm.__indirect_function_table.set(slot,cut);
  for (let cpl=0;cpl<4;++cpl) for (let rpl=0;rpl<4;++rpl) for (let type=0;type<32;++type) for (let present=0;present<2;++present) {
    const low=0x120000345678bcddn|BigInt(type|present*128)<<40n;
    reset(source,meta,{cpl,selector:24|rpl,low,high:0xffff8000n,flags:0x108d7n});
    const vector=cpl || type!==(meta.task ? 9 : 2) ? 13 : !present ? 11 : 0;
    compare(meta,24|rpl,vector,cpl ? 0 : 24); ++models;
  }
  for (let selector=0;selector<8;++selector) {
    reset(source,meta,{selector}); const vector=selector>=4 || meta.task ? 13 : 0;
    compare(meta,selector,vector,selector>=4 ? 4 : 0); ++models;
  }
  for (let upperType=1;upperType<16;++upperType) {
    reset(source,meta,{high:BigInt(upperType)<<40n}); compare(meta,24,13,24); ++models;
  }
  reset(source,meta,{limit:38}); compare(meta,24,13,24); ++models;
  // The loaded base is not dereferenced by LLDT/LTR. Canonicality of a later
  // LDT/TSS access belongs to that access, not a guessed load-time fault.
  reset(source,meta,{high:0x00008000n}); compare(meta,24,0,0); ++models;
  for (const offset of [4080,4081,4088,4090,4095]) for (let protection=0;protection<3;++protection) {
    reset(source,meta,{offset,protection});
    const vector=offset+16>4096 && (protection===1 || protection===2 && meta.task) ? 14 : 0;
    compare(meta,24,vector,protection===2 ? 3 : 0,offset); ++models;
  }
  // CPL denial precedes source #PF/#SS, including a completely absent GDT.
  if (meta.memory && meta.form!==3) for (const cpl of [0,1,2,3]) {
    reset(source,meta,{cpl,sourceOffset:4095,protection:1});
    compare(meta,24,cpl ? 13 : 14,0); ++models;
  }
  // An upper physical-owner miss can safely restart: no descriptor mutation
  // was committed and CPU remains pinned. Use actual page supply/dispatch.
  reset(source,meta,{offset:4088,resident:false});
  const cpu=Buffer.from(data.subarray(state,state+1256)), cache=Buffer.from(data.subarray(hidden,hidden+136));
  assert.equal(vm.vm_run(port,9n,1),2n); assert.deepEqual(data.subarray(state,state+1256),cpu);
  assert.deepEqual(data.subarray(hidden,hidden+136),cache); assert.equal(data[first+4088+5],meta.task ? 0x89 : 0x82);
  assert.equal(vm.vm_page_prepare(port,request),0);
  const wanted=view.getBigUint64(request+8,true), target=view.getUint32(request+24,true);
  assert.equal(wanted,0x9000n); data.fill(0,base+target,base+target+4096);
  const ticket=view.getBigUint64(request+40,true);
  assert.equal(vm.vm_page_commit(port,ticket),0); assert.equal(vm.vm_page_commit(port,ticket),-1);
  compare(meta,24,0,0,4088); ++waits;
}
// Every row is unique and joins a known emitted form. QEMU admits legacy
// 16-bit TSS type 1 in long mode; Intel marks it reserved. Preserve the
// discrepancy, do not turn this reference implementation into the ISA.
const trace=(await readFile(traceFile,'utf8')).trim().split(/\r?\n/).map(line=>line.trim().split(/\s+/).map(word=>BigInt(`0x${word}`)));
assert.equal(trace.length,3072);
for (let index=0;index<trace.length;++index) {
  const row=trace[index]; assert.equal(row.length,16); assert.equal(row[0],BigInt(index));
  const task=Number(row[1]), prefix=Number(row[2]), memory=Number(row[3]), type=Number(row[4]), present=Number(row[5]), rpl=Number(row[6]);
  assert.equal(rpl,index&3); assert.equal(present,(index>>2)&1); assert.equal(type,(index>>3)&31);
  assert.equal(memory,(index>>8)&1); assert.equal(prefix,Math.floor(index/512)%3); assert.equal(task,Math.floor(index/1536));
  const vector=type!==(task ? 9 : 2) ? 13 : !present ? 11 : 0;
  if (task && type===1) {
    assert.equal(Number(row[8]),present ? 0 : 11); assert.equal(Number(row[9]),present ? 0 : 24);
    assert.equal(row[15],row[7]|(present ? 2n<<40n : 0n));
    assert.equal(row[14],present ? row[11] : row[10]); assert.equal(row[12],row[13]);
    ++knownOracleDifferences; continue;
  }
  assert.equal(Number(row[8]),vector); assert.equal(Number(row[9]),vector ? 24 : 0);
  assert.equal(row[12],row[13]); assert.equal(row[15],row[7]|(!vector && task ? 2n<<40n : 0n));
  assert.equal(row[14],vector ? row[10] : row[11]);
  const fixture=fixtures[task*72+prefix*24+(memory ? 16 : 0)];
  reset(fixture.source,fixture.meta,{selector:24|rpl,low:row[7],flags:row[12]});
  put(state+432+(12+task)*8,row[10]); vm.__indirect_function_table.set(slot,fixture.cut);
  compare(fixture.meta,24|rpl,vector,vector ? 24 : 0); ++native;
}
console.log(JSON.stringify({format:'c-wasm-system-segment-v1',status:'pass',parity,models,waits,nativeComparisons:native,
  nativeRows:trace.length,knownOracleDifferences,oracle:'QEMU TCG CPL0, not physical hardware',
  hiddenCacheAndCrossPageFaults:'Intel SDM model, not fully observed system faults',linuxBoot:'not-tested'},null,2));
