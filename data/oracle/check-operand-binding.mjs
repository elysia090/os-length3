// Signed operand binding models through C source ownership/MMU, not Linux boot.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {CompiledModules} from '../../src/v2/web/compiled-modules.mjs';
const [vmFile,compilerFile,...args]=process.argv.slice(2);
const directories=args.filter(x=>!x.startsWith('--'));
if(!compilerFile || directories.length>1 || args.some(x=>x.startsWith('--') && x!=='--memory')
  || args.filter(x=>x==='--memory').length>1)
  throw new Error('usage: check-operand-binding.mjs VM.WASM COMPILER.WASM [FRESH-NATIVE-RECORDS] [--memory]');
const nativeDirectory=directories[0];
const memory=new WebAssembly.Memory({initial:32,maximum:34}),coldMemory=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:coldMemory}})).instance.exports;
assert.equal(vm.vm_entry_abi(),3);assert.equal(cc.compiler_entry_abi(),3);
assert.equal(cc.compiler_report_bytes(),80);assert.equal(vm.vm_source_metadata_bytes(),6880);
let data=Buffer.from(memory.buffer),view=new DataView(memory.buffer);
const cold=Buffer.from(coldMemory.buffer),cv=new DataView(coldMemory.buffer);
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const directory=vm.vm_arena_min(),rows=directory+1024,branches=directory+2048,base=directory+4096;
const port=base+2048,segments=base+1408,codeView=base+2112,table=vm.__indirect_function_table;
const firstSlot=vm.vm_slot_min();table.grow(Math.max(0,firstSlot+vm.vm_source_capacity()-table.length));
const codePhysical=0x18000n,ramPhysical=0x19000n,tailPhysical=0x1a000n;
const pageOffset=physical=>base+Number(physical)+4096;
const put=(at,x)=>view.setBigUint64(at,BigInt.asUintN(64,BigInt(x)),true);
const cpu=()=>Buffer.from(data.subarray(base,base+1256));
const entries=[0x400000n,0x100000000n,0xffffffff81033000n];
const displacements=[-2147483648,-8192,-4096,-8,-1,0,1,4092,4095,2147483647];
const families=[
  {name:'load64-rip',prefix:[0x48,0x8b,0x05],bytes:8},
  {name:'store64-rip',prefix:[0x48,0x89,0x05],bytes:8,store:true},
  {name:'load32-rip',prefix:[0x8b,0x05],bytes:4},
  {name:'load64-eip',prefix:[0x67,0x48,0x8b,0x05],bytes:8,address32:true},
  {name:'store64-eip',prefix:[0x67,0x48,0x89,0x05],bytes:8,address32:true,store:true},
];
if(args.includes('--memory'))families.push(
  {name:'load64-rdi',prefix:[0x48,0x8b,0x87],bytes:8,baseRank:7},
  {name:'store64-rdi',prefix:[0x48,0x89,0x87],bytes:8,baseRank:7,store:true},
  {name:'load64-rsp',prefix:[0x48,0x8b,0x84,0x24],bytes:8,baseRank:4},
  {name:'load64-scaled-index',prefix:[0x48,0x8b,0x84,0x8f],bytes:8,baseRank:7,indexRank:1,scale:4},
  {name:'load64-address32-index',prefix:[0x67,0x48,0x8b,0x84,0x8f],bytes:8,baseRank:7,indexRank:1,scale:4,address32:true},
  {name:'load64-disp8',prefix:[0x48,0x8b,0x47],bytes:8,baseRank:7,displacementBytes:1},
);
let emissions=0,comparisons=0,fetchFaults=0,dataFaults=0,bindingRefusals=0,sourceRevocations=0;
let nativeEmissions=0;
const bodies=new Map(),owner=new CompiledModules({machine:{memory,access:vm.vm_access}},
  {maximumEntries:1024,maximumBytes:262144});
function setup(entry,source,example,displacement){
  vm.vm_close();data.fill(0,directory);
  for(let rank=0;rank<26;++rank){
    const physical=BigInt((rank+1)*4096),at=directory+rank*32;
    put(at,physical);view.setUint32(at+8,Number(physical)+4096,true);
    view.setUint32(at+12,3,true);view.setUint32(at+16,1,true);
  }
  let nextTable=0x2000n;
  function map(address,physical){
    let current=0x1000n;
    for(const shift of [39n,30n,21n]){
      const at=pageOffset(current)+Number(address>>shift&511n)*8;
      let pte=view.getBigUint64(at,true);
      if(!pte){assert(nextTable<codePhysical);pte=nextTable|0x67n;nextTable+=4096n;put(at,pte);}
      current=pte&~4095n;
    }
    const at=pageOffset(current)+Number(address>>12n&511n)*8;put(at,physical|0x67n);return at;
  }
  const address=BigInt.asUintN(example.address32?32:64,entry+BigInt(source.length)+BigInt(displacement));
  const page=address&~4095n,second=BigInt.asUintN(64,page+4096n);
  const targetPte=map(page,ramPhysical);map(second,tailPhysical);const codePte=map(entry,codePhysical);
  const code=pageOffset(codePhysical),ram=pageOffset(ramPhysical),tail=pageOffset(tailPhysical);
  data.fill(0x93,ram,ram+4096);data.fill(0x6d,tail,tail+4096);
  data.fill(0x90,code,code+4096);data.set(source,code);
  for(let rank=0;rank<16;++rank)put(base+rank*8,BigInt(rank+1)*0xabcdef012345n);
  put(base,0x1122334455667788n);put(base+384,entry);put(base+392,0x10202);
  if(example.baseRank!==undefined){
    const index=example.indexRank===undefined?0n:3n;
    let anchor=BigInt.asUintN(64,entry+BigInt(source.length)-index*BigInt(example.scale||1));
    if(example.address32)anchor=BigInt.asUintN(32,anchor)|0xdeadbeef00000000n;
    put(base+example.baseRank*8,anchor);
    if(example.indexRank!==undefined)put(base+example.indexRank*8,index);
  }
  put(base+400,0x80010011);put(base+408,0x1000);put(base+416,32);put(base+424,0xd00);
  put(base+488,8);put(base+600,0x400);put(base+1128,41);put(port,9);
  view.setUint32(segments,2,true);view.setUint32(segments+36,0xa09b,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,directory,26,26,branches,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
  const at=i=>{
    const a=BigInt.asUintN(64,address+BigInt(i)),p=a&~4095n;
    return (p===entry?code:p===page?ram:tail)+Number(a&4095n);
  };
  return {address,at,codePte,targetPte,targetPage:page,code,ram,tail};
}
async function admit(entry,source){
  assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);
  const slot=view.getUint32(rows+16,true),borrowed=view.getUint32(codeView+16,true);
  cold.set(data.subarray(borrowed,borrowed+4096),input);
  assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
  assert.equal(cv.getBigUint64(report+32,true),BigInt(source.length));
  const binding=cv.getUint32(report+76,true);
  const body=Buffer.from(cold.subarray(output,output+Number(cv.getBigUint64(report+40,true))));
  const instance=await owner.get(body);assert.equal(instance.exports.cut.length,4);
  table.set(slot,instance.exports.cut);
  assert.equal(vm.vm_source_publish(source.length,1,binding,rows),0);
  assert.equal(view.getUint32(rows+20,true),binding);++emissions;
  return {binding,body};
}
try{
  if(nativeDirectory)for(const name of (await readdir(nativeDirectory)).filter(n=>/^memory-\d+\.json$/.test(n))){
    const prefix=path.join(nativeDirectory,name.slice(0,-5)),meta=JSON.parse(await readFile(prefix+'.json','utf8'));
    cold.set(await readFile(prefix+'.source-page'),input);
    const entry=BigInt(meta.entry);
    assert.equal(cc.compiler_open_pages(input,1,entry&~4095n,9n),0);
    assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
    assert.equal(cv.getUint32(report+76,true),meta.operandBinding);
    const actual=cold.subarray(output,output+Number(cv.getBigUint64(report+40,true)));
    assert(actual.equals(await readFile(prefix+'.wasm')),'exact native/cold C emission: '+name);++nativeEmissions;
  }
  for(const example of families)for(const entry of entries)for(const displacement of
      example.displacementBytes===1?[-128,-8,-1,0,1,120,127]:displacements){
    const displacementBytes=example.displacementBytes||4;
    const source=Buffer.alloc(example.prefix.length+displacementBytes);source.set(example.prefix);
    source.writeIntLE(displacement,example.prefix.length,displacementBytes);
    const {at,codePte,code,ram,tail}=setup(entry,source,example,displacement);
    const {body,binding}=await admit(entry,source);
    assert.equal(binding,displacement>>>0);
    if(bodies.has(example.name))assert(body.equals(bodies.get(example.name)),'one exact body: '+example.name);
    else bodies.set(example.name,body);
    const expected=cpu(),images=new Map([code,ram,tail].map(start=>[start,Buffer.from(data.subarray(start,start+4096))]));
    expected.writeBigUInt64LE(entry+BigInt(source.length),384);
    expected.writeBigUInt64LE(0x202n,392);expected.writeBigUInt64LE(42n,1128);
    let value=0n;
    for(let i=0;i<example.bytes;++i){
      const address=at(i);
      if(example.store){
        const byte=Number(0x1122334455667788n>>BigInt(i*8)&255n);
        // Physical owners, not virtual adjacency, determine the target image.
        const ownerStart=[code,ram,tail].find(s=>address>=s && address<s+4096);
        images.get(ownerStart)[address-ownerStart]=byte;
      }else value|=BigInt(data[address])<<BigInt(i*8);
    }
    if(!example.store)expected.writeBigUInt64LE(value,0);
    const beforeBinding=cpu();
    view.setUint32(rows+20,binding^1,true);assert.equal(vm.vm_bind_execution(rows,1,9n),-1);
    assert(cpu().equals(beforeBinding),'binding refusal preserves CPU');
    ++bindingRefusals;view.setUint32(rows+20,binding,true);
    assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    const result=vm.vm_run(port,9n,1);
    const codeTouched=example.store && Array.from({length:example.bytes},(_,i)=>at(i))
      .some(address=>address>=code && address<code+source.length);
    assert.equal(result,codeTouched?5n:1n,example.name);
    assert(cpu().equals(expected),`${example.name}: whole CPU, displacement ${displacement}`);
    for(const [start,image]of images)assert(data.subarray(start,start+4096).equals(image),'exact physical image');
    assert.equal(vm.vm_source_retired(),1n);++comparisons;
    setup(entry,source,example,displacement);await admit(entry,source);
    put(codePte,0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    const before=cpu();assert.equal(vm.vm_run(port,9n,1),115n);assert(cpu().equals(before));++fetchFaults;
    const fault=setup(entry,source,example,displacement);
    if(fault.targetPage!==entry){
      await admit(entry,source);put(fault.targetPte,0);
      assert.equal(vm.vm_bind_execution(rows,1,9n),0);const before=cpu();
      assert.equal(vm.vm_run(port,9n,1),115n);assert(cpu().equals(before));
      assert.equal(BigInt.asUintN(64,view.getBigUint64(port+16,true)),fault.address);
      assert.equal(view.getUint32(port+24,true),14);assert.equal(view.getUint32(port+28,true),example.store?2:0);
      assert.equal(vm.vm_source_retired(),0n);++dataFaults;
    }
    setup(entry,source,example,displacement);await admit(entry,source);
    assert.equal(vm.vm_access(port,entry,1,2,BigInt(source[0])),0n);
    assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n,
      'even equal-value code writes require a new cold source admission');++sourceRevocations;
  }
  assert.equal(owner.stats().compilations,families.length);
  console.log(JSON.stringify({format:'c-wasm-operand-binding-v1',status:'pass',linuxBoot:'not-tested',
    emissions,nativeEmissions,comparisons,fetchFaults,dataFaults,bindingRefusals,sourceRevocations,families:families.length,
    engine:owner.stats(),sourceRowBytes:24,sourceMetadataBytes:vm.vm_source_metadata_bytes(),reportBytes:80,
    oracle:'explicit signed/address-size/full-state models through C-MMU and exact source ownership; independent native ISA tests separate'},null,2));
}finally{owner.close();vm.vm_close();cc.compiler_close();for(let rank=0;rank<vm.vm_source_capacity();++rank)table.set(firstSlot+rank,null);}
