// Native value-state observations and real C-MMU/dispatcher ordering checks.
// Single-owner ordinary Memory only; not a concurrent hardware or boot proof.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,compilerFile,directory,beforeDirectory,...extra]=process.argv.slice(2);
if(!directory || !beforeDirectory || extra.length)
  throw new Error('usage: check-memory-order.mjs VM.WASM COMPILER.WASM NATIVE-DIRECTORY OBSERVE-ONLY-DIRECTORY');
const memory=new WebAssembly.Memory({initial:8}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),cold=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const dir=vm.vm_arena_min(),rows=dir+512,base=dir+4096,port=base+2048,segments=base+1408;
const code=base+24576,payload=base+28672,entry=0x400000n,address=0x401000n;
const slot=vm.__indirect_function_table.grow(3),put=(at,x)=>v.setBigUint64(at,BigInt(x),true);
const cpu=()=>Buffer.from(data.subarray(base,base+1256));
let parity=0,native=0,stable=0,controls=0,refusals=0,sharedRefusals=0,fetches=0,ordering=0,growth=0,crossing=0;
function reset(source,state) {
  data.fill(0,dir);data.set(state,base);
  for(let i=0;i<6;++i) {
    const p=dir+i*32;put(p,(i<4?i+1:i+4)*4096);
    v.setUint32(p+8,(i+2)*4096,true);v.setUint32(p+12,3,true);v.setUint32(p+16,1,true);
  }
  put(base+8192,0x2067);put(base+12288,0x3067);put(base+16384+16,0x4067);
  put(base+20480,0x8067);put(base+20488,0x9067);data.set(source,code);
  put(port,9);put(port+8,0xabcdef9887654321n);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa0fb,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,6,6,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
}
function bind(at=entry,length=3,index=slot) {
  put(rows,at);v.setUint32(rows+8,length,true);v.setUint32(rows+12,1,true);
  v.setUint32(rows+16,index,true);v.setUint32(rows+20,0,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
async function emit(source,at=entry) {
  cold.set(source,input);assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
  assert.equal(cc.compiler_emit(at,1024,output,65536,report),0);
  return Buffer.from(cold.subarray(output,output+Number(cv.getBigUint64(report+40,true))));
}
for(let form=0;form<120;++form) {
  const prefix=path.join(directory,`memory-order-${form}`),old=path.join(beforeDirectory,`memory-order-${form}`);
  const source=await readFile(`${prefix}.source-page`),meta=JSON.parse(await readFile(`${prefix}.json`));
  const emitted=await readFile(`${prefix}.wasm`),records=await readFile(`${prefix}.cases`);
  assert.equal(meta.native,64);assert.equal(meta.stateBytes,1256);assert.equal(meta.recordBytes,2512);
  assert.equal(records.length,meta.native*meta.recordBytes);
  assert(records.equals(await readFile(`${old}.cases`)),'pre-lowering native observations unchanged');stable+=meta.native;
  assert(source.equals(await readFile(`${old}.source-page`)));
  assert((await emit(source)).equals(emitted),'native C / cold C exact emitted bytes');++parity;
  assert.equal(cv.getBigUint64(report+24,true),1n);assert.equal(cv.getBigUint64(report+32,true),BigInt(meta.sourceBytes));
  assert.equal(cv.getUint32(report+60,true),6);assert.equal(cv.getUint32(report+68,true),0);
  assert.equal(cv.getUint32(report+72,true),0);
  assert(emitted.length<=245,'empty ordering frontier must not acquire a port or guest payload');
  const module=await WebAssembly.compile(emitted);
  assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'}]);
  const cut=(await WebAssembly.instantiate(module,{machine:{memory}})).exports.cut;
  vm.__indirect_function_table.set(slot,cut);
  await assert.rejects(WebAssembly.instantiate(module,{machine:{memory:new WebAssembly.Memory({initial:8,maximum:8,shared:true})}}),WebAssembly.LinkError);
  ++sharedRefusals;
  for(let row=0;row<meta.native;++row)for(const dispatch of [false,true])for(const rf of [0n,0x10000n]) {
    const r=records.subarray(row*2512,(row+1)*2512),expected=Buffer.from(r.subarray(1256));
    reset(source,r.subarray(0,1256));put(base+392,v.getBigUint64(base+392,true)|rf);bind(entry,meta.sourceBytes);
    const before=Buffer.from(data);expected.copy(before,base);
    assert.equal(dispatch?vm.vm_run(port,9n,1):cut(base,port),1n,`form ${form}/${row}`);
    assert(cpu().equals(expected),'complete native CPU state, not just GPRs');
    if(!dispatch)assert(data.equals(before),'no port, RAM or private-memory mutation');
    else {assert.equal(vm.vm_completed(),1);assert.equal(vm.vm_source_retired(),1n);}
    ++native;
  }
  const state=records.subarray(0,1256);
  // Fences are not SIMD arithmetic: EM/TS/OSFXSR do not introduce #UD/#NM.
  // These direct context models are separate from native user-mode evidence.
  for(let cpl=0;cpl<4;++cpl)for(let bits=0;bits<8;++bits)for(const rf of [0n,0x10000n]) {
    reset(source,state);put(base+400,0x80010011n|BigInt(bits&3)<<2n);
    put(base+416,bits&4?0x220n:0x20n);put(base+488,16+cpl);
    put(base+392,0x40603n|rf);const expected=Buffer.from(data);
    expected.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),base+384);
    expected.writeBigUInt64LE(0x40603n,base+392);expected.writeBigUInt64LE(43n,base+1128);
    // A port is intentionally ignored, even when overlapping or nonresident.
    assert.equal(cut(base,bits&1?-1:base),1n);assert(data.equals(expected));++controls;
  }
  for(const [stateOffset,flags,dr7,rip] of [
    [base+1,0x202n,0x400n,entry],[0xfffffff8,0x202n,0x400n,entry],
    [data.length-1256+8,0x202n,0x400n,entry],[base,0x302n,0x400n,entry],
    [base,0x10302n,0x400n,entry],[base,0x202n,0x401n,entry],[base,0x202n,0x400n,entry+1n],
  ]) {
    reset(source,state);put(base+392,flags);put(base+600,dr7);put(base+384,rip);
    const before=Buffer.from(data);assert.equal(cut(stateOffset,port),6n);assert(data.equals(before));++refusals;
  }
  for(const [leaf,result,error] of [[0n,115n,20],[0x8000000000008067n,115n,21]]) {
    reset(source,state);put(base+20480,leaf);bind(entry,meta.sourceBytes);const before=cpu();
    assert.equal(vm.vm_run(port,9n,1),result);assert(cpu().equals(before));
    assert.equal(v.getUint32(port+24,true),14);assert.equal(v.getUint32(port+28,true),error);
    assert.equal(vm.vm_source_retired(),0n);assert.equal(vm.vm_completed(),0);++fetches;
  }
  reset(source,state);v.setUint32(dir+4*32+16,3,true);bind(entry,meta.sourceBytes);const before=cpu();
  assert.equal(vm.vm_run(port,9n,1),2n);assert(cpu().equals(before));assert.equal(vm.vm_source_retired(),0n);++fetches;
  v.setUint32(dir+4*32+16,1,true);bind(entry,meta.sourceBytes);
  assert.equal(vm.vm_run(port,9n,1),1n);assert.equal(vm.vm_source_retired(),1n);++fetches;
  reset(source,state);bind(entry,meta.sourceBytes);const stale=cpu();
  assert.equal(vm.vm_run(port,8n,1),5n);assert(cpu().equals(stale));assert.equal(vm.vm_source_retired(),0n);++fetches;
}

// Compile each part of a real store -> fence -> load through the common C
// entry point. Re-admit after a write, never reuse stale code admission.
for(const opcode of [0xe8,0xf0,0xf8]) {
  const source=Buffer.alloc(4096,0x90);source.set([0x48,0x89,0x07,0x0f,0xae,opcode,0x48,0x8b,0x0f]);
  const cuts=[];
  for(let step=0;step<3;++step) {
    const bytes=await emit(source,entry+BigInt(step*3));assert.equal(cv.getBigUint64(report+24,true),1n);
    assert.equal(cv.getBigUint64(report+32,true),3n);
    const cut=(await WebAssembly.instantiate(bytes,{machine:{memory,access:vm.vm_access}})).instance.exports.cut;
    vm.__indirect_function_table.set(slot+step,cut);cuts.push(cut);
  }
  const state=await readFile(path.join(directory,'memory-order-0.cases'));
  for(let sample=0;sample<64;++sample) {
    const value=BigInt.asUintN(64,0x334477aabbcc1100n+BigInt(sample)*0x1ff21n);
    reset(source,state.subarray(0,1256));put(base,value);put(base+56,address+128n);put(payload+128,0);
    for(let step=0;step<3;++step) {
      bind(entry+BigInt(step*3),3,slot+step);
      assert.equal(vm.vm_run(port,9n,1),step===0?5n:1n);
      assert.equal(vm.vm_source_retired(),1n);assert.equal(v.getBigUint64(base+1128,true),43n+BigInt(step));
      assert.equal(v.getBigUint64(base+384,true),entry+BigInt((step+1)*3));
      assert.equal(v.getBigUint64(payload+128,true),value,'store commits before fence/load');
    }
    assert.equal(v.getBigUint64(base+8,true),value,'subsequent load sees the committed payload');++ordering;
    reset(source,state.subarray(0,1256));put(base,value);put(base+56,address+128n);
    put(base+20488,0);bind(entry,3,slot);const before=cpu();
    assert.equal(vm.vm_run(port,9n,1),115n);assert(cpu().equals(before));assert.equal(vm.vm_source_retired(),0n);
    assert.equal(v.getBigUint64(base+384,true),entry,'prior failed store cannot reach fence');++ordering;
  }
}
// The fence's value action is empty, but the complete two-page executable
// frontier must still be admitted before any retirement.
for(const opcode of [0xe8,0xf0,0xf8]) {
  const source=Buffer.alloc(8192,0x90);source.set([0x0f,0xae,opcode],4095);
  cold.set(source,input);assert.equal(cc.compiler_open_pages(input,2,entry,9n),0);
  assert.equal(cc.compiler_emit(entry+4095n,1024,output,65536,report),0);
  assert.equal(cv.getBigUint64(report+24,true),1n);assert.equal(cv.getBigUint64(report+32,true),3n);
  const cut=(await WebAssembly.instantiate(cold.subarray(output,output+Number(cv.getBigUint64(report+40,true))),
    {machine:{memory}})).instance.exports.cut;
  vm.__indirect_function_table.set(slot,cut);
  const r=await readFile(path.join(directory,'memory-order-0.cases')),state=r.subarray(0,1256);
  for(const problem of ['none','missing','nx','deferred']) {
    reset(source,state);put(base+384,entry+4095n);
    if(problem==='missing')put(base+20488,0);
    if(problem==='nx')put(base+20488,0x8000000000009067n);
    if(problem==='deferred')v.setUint32(dir+5*32+16,3,true);
    bind(entry+4095n,3);const before=cpu();
    assert.equal(vm.vm_run(port,9n,1),problem==='none'?1n:problem==='deferred'?2n:115n);
    assert.equal(vm.vm_source_retired(),problem==='none'?1n:0n);
    if(problem!=='none')assert(cpu().equals(before));++crossing;
  }
  const tiny=new WebAssembly.Memory({initial:1,maximum:2});
  const one=await readFile(path.join(directory,`memory-order-${opcode===0xe8?0:opcode===0xf0?40:80}.wasm`));
  const ordinary=(await WebAssembly.instantiate(one,{machine:{memory:tiny}})).instance.exports.cut;
  const prior=Buffer.from(tiny.buffer);assert.equal(ordinary(65536,-1),6n);assert(Buffer.from(tiny.buffer).equals(prior));++growth;
  assert.equal(tiny.grow(1),1);const now=Buffer.from(tiny.buffer);now.set(state,65536);
  const expected=Buffer.from(now);expected.writeBigUInt64LE(entry+3n,65536+384);
  expected.writeBigUInt64LE(43n,65536+1128);
  assert.equal(ordinary(65536,-1),1n);assert(now.equals(expected));++growth;
}
for(let s=0;s<3;++s)vm.__indirect_function_table.set(slot+s,null);
console.log(JSON.stringify({format:'single-owner-memory-order-comparison-v1',status:'pass',
  linuxBoot:'not-tested',concurrentMemoryOrdering:'not-tested',nativeColdParity:parity,
  unchangedPreLoweringNativeObservations:stable,nativeFullStateComparisons:native,
  controlContextModels:controls,entryRefusals:refusals,sharedMemoryLinkRefusals:sharedRefusals,
  actualCInstructionFetchChecks:fetches,actualCStoreFenceLoadChecks:ordering,
  crossPageExecutableFrontierChecks:crossing,ordinaryMemoryGrowthChecks:growth},null,2));
