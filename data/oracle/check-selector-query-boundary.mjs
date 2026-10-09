// Actual C MMU/compiled/table execution. Expected transitions are models;
// the native LDT observer is independent and separate.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile]=process.argv.slice(2);
if(!compilerFile)throw new Error('VM.WASM COMPILER.WASM');
const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const dir=vm.vm_arena_min(),cpu=dir+4096,rows=dir+512,segments=cpu+1408,port=cpu+2048,codeView=port+80;
const ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,entry=0x400000n,payload=i=>cpu+(i+2)*4096;
const put=(at,x)=>v.setBigUint64(at,BigInt(x),true),table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));
let comparisons=0,faults=0,waits=0,retries=0,success=0;
async function compile(source){c.fill(0x90,ci,ci+4096);c.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);
  const binding=cv.getUint32(cr+76,true),cut=(await WebAssembly.instantiate(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))),
    {machine:{memory,access:vm.vm_access,descriptor:vm.vm_descriptor,checkpoint:vm.vm_checkpoint}})).instance.exports.cut;cc.compiler_close();return {cut,binding};}
function reset(source,cpl){vm.vm_close();a.fill(0,dir);
  [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000,0xa000,0xb000,0xc000,0xd000].forEach((address,i)=>{
    put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
  put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2)+16,0x4067);
  for(let page=0;page<6;++page)put(payload(3)+page*8,BigInt(0x8067+page*4096));
  a.set(source,payload(4));put(cpu,0xabcdef0123456789n);put(cpu+384,entry);put(cpu+392,0x10a93);put(cpu+400,0x80010031);
  put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0x500);put(cpu+488,8|cpl);put(cpu+528,0x50);put(cpu+600,0x400);put(cpu+1128,42);put(port,9);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b|(cpl<<5),true);
}
function bind({cut,binding},source){assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,10,10,dir+2048,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
  assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),cut);assert.equal(vm.vm_source_publish(source.length,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);}
function expected(before,source,width,limit,valid){const state=Buffer.from(before);let value=limit?0xffffffffn:0xc0f200n;
  if(valid){if(width===2)value=(state.readBigUInt64LE(0)&~0xffffn)|(value&0xffffn);state.writeBigUInt64LE(value,0);}
  state.writeBigUInt64LE((state.readBigUInt64LE(392)&~0x10040n)|(valid?64n:0n),392);state.writeBigUInt64LE(entry+BigInt(source.length),384);state.writeBigUInt64LE(43n,1128);return state;}
for(const limit of [false,true])for(const width of [2,4,8])for(const mem of [false,true]){
  const source=Buffer.from([...(width===2?[0x66]:width===8?[0x48]:[]),0x0f,limit?3:2,mem?7:0xc2]),made=await compile(source);
  for(const cpl of [0,3])for(const cross of [false,true])for(const selector of [0,8,11,12,16])
  for(const problem of ['none','source-pf','source-wait','descriptor-pf','descriptor-wait','readonly']){
    reset(source,cpl);const sourceAddress=cross?0x401fffn:0x401010n,base=cross?0x403ff4n:0x403000n;
    put(cpu+56,sourceAddress);put(cpu+16,0x1234567800000000n|BigInt(selector));put(cpu+448,base);put(cpu+456,15);
    put(segments+104,base);v.setUint32(segments+112,15,true);v.setUint32(segments+116,0x82,true);
    v.setUint16(payload(5)+Number(sourceAddress-0x401000n),selector,true);put(payload(7)+(cross?4092:8),0x00cff2000000ffffn);
    const sourcePage=cross?2:1,descriptorPage=cross?4:3;
    if(problem==='source-pf')put(payload(3)+sourcePage*8,0);
    if(problem==='descriptor-pf')put(payload(3)+descriptorPage*8,0);
    if(problem==='source-wait')v.setUint32(dir+(4+sourcePage)*32+16,3,true);
    if(problem==='descriptor-wait')v.setUint32(dir+(4+descriptorPage)*32+16,3,true);
    if(problem==='readonly'){put(payload(3)+8,0x9065);put(payload(3)+16,0xa065);put(payload(3)+24,0xb061);put(payload(3)+32,0xc061);}
    bind(made,source);const before=Buffer.from(a.subarray(cpu,cpu+1256)),coordinate=selector!==0&&selector!==16;
    const sourceProblem=mem&&problem.startsWith('source-'),descriptorProblem=coordinate&&problem.startsWith('descriptor-');
    const fault=(sourceProblem&&problem.endsWith('pf'))||(descriptorProblem&&problem.endsWith('pf'));
    const wait=(sourceProblem&&problem.endsWith('wait'))||(descriptorProblem&&problem.endsWith('wait'));
    const result=vm.vm_run(port,9n,1);assert.equal(result,fault?115n:wait?2n:1n,`${limit}/${width}/${mem}/${cpl}/${cross}/${selector}/${problem}`);
    if(fault){assert.equal(v.getUint32(port+24,true),14);assert.equal(v.getUint32(port+28,true),sourceProblem&&cpl===3?4:0);++faults;}
    if(wait)++waits;if(!fault&&!wait)++success;
    assert(a.subarray(cpu,cpu+1256).equals(fault||wait?before:expected(before,source,width,limit,coordinate)));
    assert.equal(vm.vm_source_retired(),fault||wait?0n:1n);
    if(wait){v.setUint32(dir+(4+sourcePage)*32+16,1,true);v.setUint32(dir+(4+descriptorPage)*32+16,1,true);
      assert.equal(vm.vm_run(port,9n,1),1n);assert(a.subarray(cpu,cpu+1256).equals(expected(before,source,width,limit,coordinate)));++retries;}
    ++comparisons;
  }
}
// A descriptor page-table A update aliases the already-read selector. The
// host wait must retain the old operand, not replay its load from changed RAM.
for(const limit of [false,true]){const source=Buffer.from([0x48,0x0f,limit?3:2,7]),made=await compile(source);reset(source,3);
  put(cpu+56,0x405020);put(cpu+448,0x403000);put(cpu+456,15);
  put(segments+104,0x3f8000);v.setUint32(segments+112,65535,true);v.setUint32(segments+116,0x82,true);
  put(payload(3)+32,0xc007);put(payload(3)+40,0x4067);put(payload(8),0x00cff2000000ffffn);put(payload(8)+32,0);
  v.setUint32(dir+8*32+16,3,true);bind(made,source);const before=Buffer.from(a.subarray(cpu,cpu+1256));
  assert.equal(vm.vm_run(port,9n,1),2n);assert(a.subarray(cpu,cpu+1256).equals(before));assert.equal(v.getBigUint64(payload(3)+32,true),0xc027n);
  v.setUint32(dir+8*32+16,1,true);assert.equal(vm.vm_run(port,9n,1),1n);
  assert(a.subarray(cpu,cpu+1256).equals(expected(before,source,8,limit,true)),'source operand survives descriptor A/D alias and wait');++retries;++comparisons;
}
vm.vm_close();console.log(JSON.stringify({status:'pass',comparisons,faults,waits,retries,success,
  scope:'C compiler/MMU/table; source-vs-supervisor descriptor faults, exact cross-page/read-only extents, source-latched residency retry and A/D alias',linuxBoot:'not-tested'}));
