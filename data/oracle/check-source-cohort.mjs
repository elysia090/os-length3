// C source-owned warm execution, not a JS branch executor or Linux boot.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {CutProgress} from '../../src/v2/vm/check/browser/cut-progress.mjs';
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
let emissions=0,retired=0,boundaryCalls=0,comparisons=0,coldMisses=0,fetchFaults=0,writeRevocations=0,continuations=0;
const matchedTimings=[];
const progress=new CutProgress(0);
let prefixChecks=0,demandChecks=0;
let sourceObservations=0,sourceRefusals=0;
function run(budget,continuing=false){
  if(!continuing)progress.reset(Number(view.getBigUint64(base+1128,true)));
  const result=vm.vm_run(port,9n,budget);
  progress.add(vm.vm_completed(),vm.vm_source_retired(),view.getBigUint64(base+1128,true),budget);
  ++prefixChecks;return result;
}
function demand(mask,admissions,interrupted=0){
  assert.equal(BigInt.asUintN(64,vm.vm_source_demands()),mask);assert.equal(vm.vm_source_admissions(),admissions);
  assert.equal(vm.vm_run_interrupted(),interrupted);++demandChecks;
}
function observe(bytes,entryAt=entry,hasTail=false){
  data.fill(0xa5,codeView,codeView+48);
  const state=cpu(),request=Buffer.from(data.subarray(port,port+64));
  assert.equal(vm.vm_run_source(port,9n,codeView),bytes);
  assert(cpu().equals(state));assert(data.subarray(port,port+64).equals(request));
  if(bytes<0){assert(data.subarray(codeView,codeView+48).every(byte=>byte===0xa5));++sourceRefusals;return;}
  assert.equal(view.getBigUint64(codeView,true),entryAt&~4095n);
  assert.equal(view.getBigUint64(codeView+8,true),9n);assert.equal(view.getUint32(codeView+16,true),code);
  assert.equal(view.getUint32(codeView+20,true),4096);
  if(hasTail){
    assert.equal(view.getBigUint64(codeView+24,true),(entryAt&~4095n)+4096n);
    assert.equal(view.getBigUint64(codeView+32,true),9n);assert.equal(view.getUint32(codeView+40,true),tail);
    assert.equal(view.getUint32(codeView+44,true),4096);
  }else assert(data.subarray(codeView+24,codeView+48).every(byte=>byte===0));
  const snapshot=Buffer.from(data.subarray(codeView,codeView+48));
  for(const [target,generation]of [[codeView,8n],[port,9n],[base,9n],[segments,9n],[directory,9n]]){
    assert.equal(vm.vm_run_source(port,generation,target),-1);
    assert(data.subarray(codeView,codeView+48).equals(snapshot));assert(cpu().equals(state));
    assert(data.subarray(port,port+64).equals(request));++sourceRefusals;
  }
  ++sourceObservations;
  assert.equal(vm.vm_source_query(port,entryAt,1024,codeView,rows),0n);
  data.fill(0xa5,codeView,codeView+48);
  assert.equal(vm.vm_run_source(port,9n,codeView),-1,'a new admission retires diagnostic ownership');
  assert(data.subarray(codeView,codeView+48).every(byte=>byte===0xa5));++sourceRefusals;
}
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
async function prime(selected=parts,limit=1024,start=entry){
  for(const part of selected){
    const at=entry+BigInt(part.offset);
    assert.equal(vm.vm_source_query(port,at,limit,codeView,rows),1n);
    const slot=view.getUint32(rows+16,true),borrowed=view.getUint32(codeView+16,true);
    cold.set(data.subarray(borrowed,borrowed+4096),input);
    assert.equal(cc.compiler_open_pages(input,1,at&~4095n,9n),0);
    let result=cc.compiler_emit(at,1,output,65536,receipt);
    if(result===-105){
      assert.equal(vm.vm_source_extend(port,codeView,rows),1n);
      const borrowedTail=view.getUint32(codeView+40,true);
      cold.set(data.subarray(borrowedTail,borrowedTail+4096),input+4096);
      assert.equal(cc.compiler_open_pages(input,2,at&~4095n,9n),0);
      result=cc.compiler_emit(at,1,output,65536,receipt);
    }
    assert.equal(result,0);
    assert.equal(cv.getBigUint64(receipt+32,true),BigInt(part.bytes));
    const module=cold.subarray(output,output+Number(cv.getBigUint64(receipt+40,true)));
    const cut=(await WebAssembly.instantiate(module,{machine:{memory,access:vm.vm_access,
      io:vm.vm_io,reserve:vm.vm_reserve,commit:vm.vm_commit,interrupt_flag:vm.vm_flag}})).instance.exports.cut;
    assert.equal(cut.length,3);table.set(slot,cut);
    assert.equal(vm.vm_source_publish(part.bytes,1,rows),0);++emissions;
  }
  assert.equal(vm.vm_source_query(port,start,limit,codeView,rows),0n);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
try{
  for(const cuts of [1,2,3,4,31,99,4096,65536]){
    reset();await prime();const expected=cpu();
    assert.equal(run(cuts),1n,'cached source cohort must consume the requested pure quantum');
    assert.equal(vm.vm_completed(),cuts);assert.equal(vm.vm_source_retired(),BigInt(cuts));
    demand(cuts===1?1n:cuts===2?3n:7n,cuts);
    observe(-1);
    expected.writeBigUInt64LE(1n,0);expected.writeBigUInt64LE(cuts===1?0x203n:0x202n,392);
    expected.writeBigUInt64LE(entry+BigInt([0,7,8][cuts%3]),384);
    expected.writeBigUInt64LE(41n+BigInt(cuts),1128);
    assert(cpu().equals(expected),'complete state, not only final RIP');
    retired+=cuts;++boundaryCalls;++comparisons;
  }
  // Fixed, non-clock workload: identical compiler/source owners, complete
  // final state and 65,536 guest retirements. The reference supervisor never
  // interprets a byte or chooses a branch; it re-admits the C-produced RIP.
  // This isolates boundary/admission fees, not x86 ALU or Linux boot speed.
  for(let sample=0;sample<5;++sample){
    reset();await prime();let started=performance.now();
    for(let cut=0;cut<65536;++cut){
      const current=view.getBigUint64(base+384,true);
      assert.equal(vm.vm_source_query(port,current,1024,codeView,rows),0n);
      assert.equal(vm.vm_bind_execution(rows,1,9n),0);assert.equal(vm.vm_run(port,9n,1),1n);
    }
    const oneCutMs=performance.now()-started,reference=cpu();
    reset();await prime();started=performance.now();
    assert.equal(vm.vm_run(port,9n,65536),1n);
    const cohortMs=performance.now()-started;
    assert(cpu().equals(reference));assert.equal(vm.vm_completed(),65536);
    matchedTimings.push({oneCutMs,cohortMs,referenceCalls:65536,cohortCalls:1});
  }
  // Cold miss yields the exact successful prefix, without a fabricated row.
  reset();await prime(parts.slice(0,1));let expected=cpu();
  expected.writeBigUInt64LE(1n,0);expected.writeBigUInt64LE(0x203n,392);
  expected.writeBigUInt64LE(entry+7n,384);expected.writeBigUInt64LE(42n,1128);
  assert.equal(run(99),1n);assert.equal(vm.vm_completed(),1);demand(1n,1);
  assert.equal(vm.vm_source_retired(),1n);assert(cpu().equals(expected));++coldMisses;++comparisons;
  assert.equal(vm.vm_source_query(port,entry+7n,1024,codeView,rows),1n);
  assert.equal(view.getUint32(rows+16,true),firstSlot+1);
  // Every warm page uses current permissions/residency. No next-page lookup
  // can suppress a completed branch; a remap is a cold miss, not identity.
  for(const mode of ['nonpresent','nx','deferred','remap','ad-write']){
    reset();data.set([0xe9,0xfb,0x0f,0,0],code);
    data.set([0x48,0xc7,0xc0,1,0,0,0],tail);
    await prime([{offset:0,bytes:5},{offset:4096,bytes:7}]);
    if(mode==='nonpresent')put(base+20488,0);
    if(mode==='nx')put(base+20488,0x8000000000009067n);
    if(mode==='deferred')view.setUint32(directory+5*32+16,3,true);
    if(mode==='remap')put(base+20488,0x8067);
    if(mode==='ad-write')put(base+20488,0x9047);
    expected=cpu();expected.writeBigUInt64LE(entry+4096n,384);
    expected.writeBigUInt64LE(0x203n,392);expected.writeBigUInt64LE(42n,1128);
    assert.equal(run(99),mode==='nonpresent'||mode==='nx'?115n:mode==='deferred'?2n:mode==='ad-write'?5n:1n);
    demand(1n,1);
    observe(-1);
    assert.equal(vm.vm_completed(),1);assert.equal(vm.vm_source_retired(),1n);
    assert(cpu().equals(expected));++comparisons;
    if(mode==='nonpresent'||mode==='nx'){
      assert.equal(view.getBigUint64(port+16,true),entry+4096n);
      assert.equal(view.getUint32(port+28,true),mode==='nx'?17:16);++fetchFaults;
    }
  }
  // A known crossing instruction has two physical code owners; neither a
  // fault nor a remapped tail may execute the old compiled function.
  for(const mode of ['valid','nx','remap']){
    reset();data[code+4095]=0x48;data.set([0x89,0xc0],tail);
    put(base+384,entry+4095n);
    await prime([{offset:4095,bytes:3}],1024,entry+4095n);
    if(mode==='nx')put(base+20488,0x8000000000009067n);
    if(mode==='remap')put(base+20488,0x8067);
    expected=cpu();
    if(mode==='valid'){
      expected.writeBigUInt64LE(entry+4098n,384);expected.writeBigUInt64LE(0x203n,392);
      expected.writeBigUInt64LE(42n,1128);
    }
    assert.equal(run(1),mode==='nx'?115n:1n);demand(mode==='valid'?1n:0n,mode==='valid'?1:0);
    assert.equal(vm.vm_completed(),mode==='valid'?1:0);
    assert(cpu().equals(expected));++comparisons;
  }
  // A completed store revokes before another cut, even when it overwrites
  // the first instruction itself. The row is not copied after the store.
  for(const alias of [false,true]){
    reset();data.set([0x48,0x89,0x05,...(alias?[0xf2,0xff,0xff,0xff]:[0xf2,0x0f,0,0])],code+7);
    await prime([{offset:0,bytes:7},{offset:7,bytes:7}]);expected=cpu();
    expected.writeBigUInt64LE(1n,0);expected.writeBigUInt64LE(entry+14n,384);
    expected.writeBigUInt64LE(0x203n,392);expected.writeBigUInt64LE(43n,1128);
    assert.equal(run(99),5n);assert.equal(vm.vm_completed(),2);demand(3n,2);
    assert.equal(vm.vm_source_retired(),2n);assert(cpu().equals(expected));
    assert.equal(view.getBigUint64(alias?code:tail,true),1n);++writeRevocations;++comparisons;
    observe(-1);
  }
  reset();data.set([0x48,0xf7,0xf3],code+7);put(base+8*3,0);
  await prime([{offset:0,bytes:7},{offset:7,bytes:3}]);expected=cpu();
  expected.writeBigUInt64LE(1n,0);expected.writeBigUInt64LE(entry+7n,384);
  expected.writeBigUInt64LE(0x203n,392);expected.writeBigUInt64LE(42n,1128);
  assert.equal(run(99),3n);assert.equal(vm.vm_completed(),1);demand(3n,2);
  observe(3,entry+7n);
  assert(cpu().equals(expected));assert.equal(view.getUint32(port+24,true),0);++comparisons;
  // A faulting instruction crosses to a noncontiguous physical page. The
  // observer borrows both original owners without clearing the #DE request.
  reset();data[code+4095]=0x48;data.set([0xf7,0xf3],tail);put(base+384,entry+4095n);put(base+8*3,0);
  await prime([{offset:4095,bytes:3}],1024,entry+4095n);expected=cpu();
  assert.equal(run(64),3n);assert.equal(vm.vm_completed(),0);demand(1n,1);
  assert(cpu().equals(expected));observe(3,entry+4095n,true);++comparisons;
  reset();data.set([0x48,0xc7,0xc0,65,0,0,0,0xee],code);put(base+16,0x45);
  await prime([{offset:0,bytes:7},{offset:7,bytes:1}]);expected=cpu();
  expected.writeBigUInt64LE(65n,0);expected.writeBigUInt64LE(entry+7n,384);
  expected.writeBigUInt64LE(0x203n,392);expected.writeBigUInt64LE(42n,1128);
  assert.equal(run(64),6n);assert.equal(vm.vm_completed(),1);demand(3n,2);
  assert(cpu().equals(expected));observe(1,entry+7n);assert.equal(data[code+7],0xee);++comparisons;
  // Narrow-source identity and stale/debug/context gates remain distinct.
  for(const mode of ['generation','context','debug','shadow']){
    reset();await prime();expected=cpu();
    if(mode==='generation')put(port,8);
    if(mode==='context'){put(base+408,0x2000);expected=cpu();}
    if(mode==='debug'){put(base+600,1);expected=cpu();} // DR7 = system[14+7].
    if(mode==='shadow')view.setUint32(segments+4,1,true);
    assert.equal(vm.vm_run(port,9n,99),mode==='generation'||mode==='context'?5n:mode==='debug'?6n:1n);
    demand(0n,0);
    assert.equal(vm.vm_completed(),0);assert(cpu().equals(expected));++comparisons;
  }
  // A later console barrier latches its own entry, not the first row of the
  // quantum. Resume survives descriptor mutation and Memory growth.
  reset();data.set([0x48,0xc7,0xc0,65,0,0,0,0xee],code);put(base+16,0x3f8);
  await prime([{offset:0,bytes:7},{offset:7,bytes:1}]);expected=cpu();
  expected.writeBigUInt64LE(65n,0);expected.writeBigUInt64LE(entry+7n,384);
  expected.writeBigUInt64LE(0x203n,392);expected.writeBigUInt64LE(42n,1128);
  assert.equal(run(99),26n);assert.equal(vm.vm_completed(),1);assert(cpu().equals(expected));demand(3n,2);
  observe(-1);
  const ticket=view.getBigUint64(port+32,true);data.fill(0xa5,rows,rows+24);
  assert.equal(run(99,true),26n);assert.equal(vm.vm_completed(),0);assert(cpu().equals(expected));demand(0n,0);
  observe(-1);
  memory.grow(1);data=Buffer.from(memory.buffer);view=new DataView(memory.buffer);assert.equal(vm.vm_grow(),0);
  assert.equal(vm.vm_console_commit(port,9n,ticket,65),1);assert.equal(vm.vm_console_commit(port,9n,ticket,65),0);
  expected.writeBigUInt64LE(entry+8n,384);expected.writeBigUInt64LE(43n,1128);
  assert.equal(run(99,true),1n);assert.equal(vm.vm_completed(),1);demand(0n,0);
  assert.equal(vm.vm_source_retired(),1n);assert(cpu().equals(expected));++continuations;++comparisons;
  assert.equal(progress.completed,2);assert.equal(progress.retired,2);
  observe(-1);
  // Both 32-bit mask banks come from actual C-selected, independently
  // compiled entries. Bit 31/63 must not disappear through signed JS masks.
  reset();const allRanks=[];
  for(let rank=0;rank<64;++rank){
    data[code+rank*5]=0xe9;view.setInt32(code+rank*5+1,rank===63?-320:0,true);
    allRanks.push({offset:rank*5,bytes:5});
  }
  await prime(allRanks);expected=cpu();
  expected.writeBigUInt64LE(0x203n,392);expected.writeBigUInt64LE(105n,1128);
  assert.equal(run(64),1n);assert.equal(vm.vm_completed(),64);assert(cpu().equals(expected));
  demand(0xffffffffffffffffn,64);
  observe(-1);
  const ranks=[],mask=vm.vm_source_demands();
  for(let bank=0;bank<2;++bank){
    let bits=Number(bank?mask>>32n:mask&0xffffffffn)>>>0;
    while(bits){ranks.push(bank*32+31-Math.clz32(bits&-bits));bits=(bits&(bits-1))>>>0;}
  }
  assert.deepEqual(ranks,Array.from({length:64},(_,rank)=>rank));
  assert.equal(vm.vm_run(port,8n,64),5n);demand(0n,0);assert(cpu().equals(expected));++comparisons;
}finally{for(let slot=firstSlot;slot<firstSlot+vm.vm_source_capacity();++slot)table.set(slot,null);vm.vm_close();cc.compiler_close();}
console.log(JSON.stringify({format:'c-wasm-source-cohort-v1',status:'pass',emissions,retired,boundaryCalls,
  comparisons,coldMisses,fetchFaults,writeRevocations,continuations,prefixChecks,demandChecks,sourceObservations,sourceRefusals,
  matchedTimings,
  oracle:'explicit source/CPU model through C MMU and compiled table; not Linux/native speedup',linuxBoot:'not-tested'},null,2));
