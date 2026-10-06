// Typed-interface routing and actual C-VM cut parity. Not whole ELF/Linux boot.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,compilerFile,oldCompilerFile,directory]=process.argv.slice(2);
if(!directory)throw new Error('VM.WASM COMPILER.WASM OLD-COMPILER.WASM NATIVE-DIRECTORY');
const source=await readFile(path.join(directory,'source-page')),native=await readFile(path.join(directory,'combined.wasm'));
const reports=await readFile(path.join(directory,'reports')),count=reports.length/80;assert.equal(count,28);
const entries=Array.from({length:count},(_,i)=>reports.readBigUInt64LE(i*80));
async function compiler(file){
  const memory=new WebAssembly.Memory({initial:16});
  const cc=(await WebAssembly.instantiate(await readFile(file),{machine:{memory}})).instance.exports;
  const bytes=Buffer.from(memory.buffer),view=new DataView(memory.buffer),input=cc.compiler_arena_min();
  return {cc,bytes,view,input,options:input+8192,output:input+16384,report:input+16384+65536};
}
const cold=await compiler(compilerFile),old=await compiler(oldCompilerFile);
assert.equal(typeof cold.cc.compiler_emit_module,'function','C compiler must emit one typed multi-cut module');
function open(c){c.bytes.set(source,c.input);assert.equal(c.cc.compiler_open_pages(c.input,1,0x400000n,9n),0);}
open(cold);open(old);
for(let i=0;i<count;++i){
  cold.view.setBigUint64(cold.options+i*16,entries[i],true);
  cold.view.setUint32(cold.options+i*16+8,1,true);cold.view.setUint32(cold.options+i*16+12,65536,true);
}
assert.equal(cold.cc.compiler_emit_module(cold.options,count,cold.output,65536,cold.report),0);
const combined=Buffer.from(cold.bytes.subarray(cold.output,cold.output+Number(cold.view.getBigUint64(cold.report+40,true))));
assert(combined.equals(native),'native and cold module emission must be byte-identical');
const oldCuts=[];let oldBytes=0;
for(let i=0;i<count;++i){
  assert.equal(old.cc.compiler_emit(entries[i],1,old.output,65536,old.report),0);
  const previous=Buffer.from(old.bytes.subarray(old.output,old.output+Number(old.view.getBigUint64(old.report+40,true))));
  assert.equal(cold.cc.compiler_emit(entries[i],1,cold.output,65536,cold.report+count*80),0);
  const now=cold.bytes.subarray(cold.output,cold.output+Number(cold.view.getBigUint64(cold.report+count*80+40,true)));
  assert(previous.equals(now),`standalone bytes must not drift: ${i}`);oldCuts.push(previous);oldBytes+=previous.length;
}
const compiled=new WebAssembly.Module(combined),imports=WebAssembly.Module.imports(compiled);
const names=imports.filter(i=>i.kind==='function').map(i=>i.name);assert.equal(names.length,22);
const memory=new WebAssembly.Memory({initial:2}),data=Buffer.from(memory.buffer),view=new DataView(memory.buffer);
const base=4096,port=8192;let trace=[];const observed=new Set();
const spies=Object.fromEntries(names.map(name=>[name,(...args)=>{trace.push([name,...args]);observed.add(name);return 0n;}]));
const bulk=new WebAssembly.Instance(compiled,{machine:{memory,...spies}}).exports;
let routeComparisons=0;
function seed(entry,cpl,rf){
  data.fill(0);for(let i=0;i<16;++i)view.setBigUint64(base+i*8,BigInt(i+1)*0x123456789abn,true);
  view.setBigUint64(base+56,0x401000n,true);view.setBigUint64(base+384,entry,true);
  view.setBigUint64(base+392,BigInt(0x202|(rf<<16)),true);view.setBigUint64(base+400,0x80010011n,true);
  view.setBigUint64(base+416,0x6b0n,true);view.setBigUint64(base+424,0xd01n,true);
  view.setBigUint64(base+488,BigInt(8|cpl),true);view.setBigUint64(base+1128,41n,true);
  view.setBigUint64(port+8,0x123456789abcdefn,true);trace=[];
}
for(let i=0;i<count;++i){
  const single=(await WebAssembly.instantiate(oldCuts[i],{machine:{memory,...spies}})).instance.exports.cut;
  const binding=reports.readUInt32LE(i*80+76);
  for(const cpl of [0,3])for(const rf of [0,1]){
    seed(entries[i],cpl,rf);const first=single(base,port,entries[i],binding);
    const state=Buffer.from(data),calls=trace;
    seed(entries[i],cpl,rf);assert.equal(bulk[`cut.${i}`](base,port,entries[i],binding),first);
    assert(data.equals(state));assert.deepEqual(trace,calls);++routeComparisons;
  }
}
assert.equal(observed.size,22,'every typed callback identity must be exercised');
const many=new WebAssembly.Module(await readFile(path.join(directory,'count-129.wasm')));
assert.equal(WebAssembly.Module.exports(many).length,129);
// Real C state/MMU/permission/source/table paths, not the routing spies above.
const ram=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory:ram}})).instance.exports;
const actual=new WebAssembly.Instance(compiled,{machine:{memory:ram,access:vm.vm_access,reserve:vm.vm_reserve,
  commit:vm.vm_commit,write_begin:vm.vm_write_begin,write_word:vm.vm_write_word,write_end:vm.vm_write_end,
  segment:vm.vm_segment,reserve_pair:vm.vm_reserve_pair,commit_pair:vm.vm_commit_pair,table:vm.vm_table,
  read_pair:vm.vm_read_pair,read_extent:vm.vm_read_extent,far_return:vm.vm_return,control:vm.vm_control,
  iret:vm.vm_iret,msr:vm.vm_msr,debug:vm.vm_debug,io:vm.vm_io,time:vm.vm_time,interrupt_flag:vm.vm_flag,
  software_interrupt:vm.vm_software_interrupt,system_transfer:vm.vm_system}}).exports;
const a=Buffer.from(ram.buffer),v=new DataView(ram.buffer),dir=vm.vm_arena_min(),cpu=dir+4096;
const rows=dir+512,branches=dir+2048,p=cpu+2048,segments=cpu+1408,codeView=p+64,code=cpu+24576,payload=cpu+28672;
const table=vm.__indirect_function_table,first=vm.vm_slot_min();table.grow(Math.max(0,first+vm.vm_source_capacity()-table.length));
const put=(at,x)=>v.setBigUint64(at,BigInt(x),true);
function reset(entry,cpl,permission){
  vm.vm_close();a.fill(0,dir);
  [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000].forEach((address,i)=>{
    put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);
  });
  put(cpu+8192,0x2067);put(cpu+12288,0x3067);put(cpu+16384+16,0x4067);
  put(cpu+20480,0x8067);put(cpu+20488,permission==='absent'?0n:permission==='readonly'?0x9065n:0x9067n);
  for(let r=0;r<16;++r)put(cpu+r*8,BigInt(r+1)*0x123456789abn);
  put(cpu+56,0x401000);put(cpu+384,entry);put(cpu+392,0x10203);put(cpu+400,0x80010011);
  put(cpu+408,0x1000);put(cpu+416,0x6b0);put(cpu+424,0xd01);put(cpu+488,8|cpl);put(cpu+1128,41);put(p,9);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);a.set(source,code);put(payload,0x1234);
  assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,6,6,branches,9n),0);
  assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
}
const realImports={memory:ram,access:vm.vm_access,reserve:vm.vm_reserve,commit:vm.vm_commit,interrupt_flag:vm.vm_flag};
let cComparisons=0;
for(const i of [0,1,2,3,19,24,25,26,27])for(const cpl of [0,3])for(const permission of ['readwrite','readonly','absent']){
  const single=(await WebAssembly.instantiate(oldCuts[i],{machine:realImports})).instance.exports.cut;
  const execute=fn=>{
    reset(entries[i],cpl,permission);assert.equal(vm.vm_source_query(p,entries[i],1,codeView,rows),1n);
    table.set(v.getUint32(rows+16,true),fn);assert.equal(vm.vm_source_publish(reports.readUInt32LE(i*80+32),1,reports.readUInt32LE(i*80+76),rows),0);
    assert.equal(vm.vm_bind_execution(rows,1,9n),0);const result=vm.vm_run(p,9n,1);
    return {result,retired:vm.vm_source_retired(),completed:vm.vm_completed(),halted:vm.vm_halted(),
      bytes:Buffer.from(a.subarray(cpu,cpu+1256)),hidden:Buffer.from(a.subarray(segments,segments+136)),
      request:Buffer.from(a.subarray(p,p+64)),payload:Buffer.from(a.subarray(payload,payload+4096))};
  };
  assert.deepEqual(execute(actual[`cut.${i}`]),execute(single));++cComparisons;
}
vm.vm_close();
console.log(JSON.stringify({format:'mixed-cut-module-v1',status:'pass',functions:count,typedImports:22,
  routeComparisons,cComparisons,standaloneByteParity:28,nativeColdByteParity:1,ulebFunctions:129,
  standaloneBytes:oldBytes,combinedBytes:combined.length,savedBytes:oldBytes-combined.length,
  oracle:'routing spies separately scoped; actual C-VM/source/MMU/permission/fault/CPU comparison against frozen standalone emitter',
  linuxBoot:'not-tested',wholeElf:'not-closed'},null,2));
