// C source-owned warm execution, not a JS branch executor or Linux boot.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile]=process.argv.slice(2);
if(!compilerFile)throw new Error('usage: check-source-cohort.mjs VM.WASM COMPILER.WASM');
const memory=new WebAssembly.Memory({initial:16,maximum:18}),coldMemory=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:coldMemory}})).instance.exports;
assert.equal(vm.vm_entry_abi(),2);assert.equal(cc.compiler_entry_abi(),2);
let data=Buffer.from(memory.buffer),view=new DataView(memory.buffer);
const cold=Buffer.from(coldMemory.buffer),cv=new DataView(coldMemory.buffer);
const input=cc.compiler_arena_min(),output=input+8192,receipt=output+65536;
const directory=vm.vm_arena_min(),rows=directory+1024,branches=directory+2048,base=directory+4096;
const port=base+2048,segments=base+1408,codeView=base+2112,code=base+24576,tail=base+28672;
const entry=0x400000n,table=vm.__indirect_function_table,firstSlot=vm.vm_slot_min();
table.grow(Math.max(0,firstSlot+vm.vm_source_capacity()-table.length));
const put=(at,value)=>view.setBigUint64(at,BigInt.asUintN(64,BigInt(value)),true);
const cpu=()=>Buffer.from(data.subarray(base,base+1256));
const parts=[{offset:0,bytes:7},{offset:7,bytes:1},{offset:8,bytes:2}];
// MOV RAX,1; CLC; JMP back. All other registers/flags/RAM are observable.
const program=[0x48,0xc7,0xc0,1,0,0,0,0xf8,0xeb,0xf6];
let emissions=0,retired=0,boundaryCalls=0;
function reset(){
  vm.vm_close();data.fill(0,directory);
  for(let rank=0;rank<6;++rank){
    const at=directory+rank*32;put(at,rank<4?(rank+1)*4096:(rank+4)*4096);
    view.setUint32(at+8,(rank+2)*4096,true);view.setUint32(at+12,3,true);view.setUint32(at+16,1,true);
  }
  put(base+8192,0x2067);put(base+12288,0x3067);put(base+16384+16,0x4067);
  put(base+20480,0x8067);put(base+20488,0x9067);
  for(let rank=0;rank<16;++rank)put(base+rank*8,BigInt(rank+1)*0x123456789abn);
  put(base+384,entry);put(base+392,0x10203);put(base+400,0x80010011);
  put(base+408,0x1000);put(base+416,32);put(base+424,0xd00);put(base+488,8);put(base+1128,41);put(port,9);
  view.setUint32(segments,2,true);view.setUint32(segments+36,0xa09b,true);
  data.fill(0x90,code,code+4096);data.set(program,code);data.fill(0x90,tail,tail+4096);
  assert.equal(vm.vm_open(base,data.length-base,4096,directory,6,6,branches,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
}
async function prime(){
  for(const part of parts){
    const at=entry+BigInt(part.offset);
    assert.equal(vm.vm_source_query(port,at,1024,codeView,rows),1n);
    const slot=view.getUint32(rows+16,true),borrowed=view.getUint32(codeView+16,true);
    cold.set(data.subarray(borrowed,borrowed+4096),input);
    assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
    assert.equal(cc.compiler_emit(at,1,output,65536,receipt),0);
    assert.equal(cv.getBigUint64(receipt+32,true),BigInt(part.bytes));
    const module=cold.subarray(output,output+Number(cv.getBigUint64(receipt+40,true)));
    const cut=(await WebAssembly.instantiate(module,{machine:{memory,access:vm.vm_access}})).instance.exports.cut;
    assert.equal(cut.length,3);table.set(slot,cut);
    assert.equal(vm.vm_source_publish(part.bytes,1,rows),0);++emissions;
  }
  assert.equal(vm.vm_source_query(port,entry,1024,codeView,rows),0n);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
try{
  reset();await prime();const expected=cpu();
  const cuts=99;assert.equal(vm.vm_run(port,9n,cuts),1n,'cached source cohort must consume the requested pure quantum');
  assert.equal(vm.vm_completed(),cuts);assert.equal(vm.vm_source_retired(),BigInt(cuts));
  expected.writeBigUInt64LE(1n,0);expected.writeBigUInt64LE(0x202n,392);expected.writeBigUInt64LE(41n+BigInt(cuts),1128);
  assert(cpu().equals(expected),'complete state, not only final RIP');retired+=cuts;++boundaryCalls;
}finally{for(let slot=firstSlot;slot<firstSlot+vm.vm_source_capacity();++slot)table.set(slot,null);vm.vm_close();cc.compiler_close();}
console.log(JSON.stringify({format:'c-wasm-source-cohort-v1',status:'pass',emissions,retired,boundaryCalls,
  oracle:'explicit source/CPU model through C MMU and compiled table; not Linux/native speedup',linuxBoot:'not-tested'},null,2));
