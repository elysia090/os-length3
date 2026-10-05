// Independent coordinate/precise-frontier models through the actual C MMU.
// Native instruction comparisons are separate; this is not Linux boot.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile]=process.argv.slice(2);
if(!compilerFile)throw new Error('usage: check-entry-binding.mjs VM.WASM COMPILER.WASM');
const memory=new WebAssembly.Memory({initial:32,maximum:34});
const coldMemory=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:coldMemory}})).instance.exports;
assert.equal(vm.vm_entry_abi(),3);assert.equal(cc.compiler_entry_abi(),3);
let data=Buffer.from(memory.buffer),view=new DataView(memory.buffer);
const cold=Buffer.from(coldMemory.buffer),cv=new DataView(coldMemory.buffer);
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const directory=vm.vm_arena_min(),rows=directory+512,base=directory+4096;
const port=base+2048,segments=base+1408,slot=vm.__indirect_function_table.grow(1);
const stack=0x500000n,codePhysical=0x8000n,ramPhysical=0x9000n;
const pageOffset=physical=>base+Number(physical)+4096;
const put=(at,x)=>view.setBigUint64(at,BigInt.asUintN(64,BigInt(x)),true);
const cpu=()=>Buffer.from(data.subarray(base,base+1256));
const addresses=[0x400000n,0x401000n,0x1400000n,0x100000000n,0xffffffff81033000n];
const examples=[
  {name:'literal-not-binding',source:[0x48,0xc7,0xc0,0,0,0x40,0],rax:()=>0x400000n},
  {name:'lea-rip',source:[0x48,0x8d,0x05,0x23,1,0,0],rax:b=>b+7n+0x123n},
  {name:'lea-eip',source:[0x67,0x48,0x8d,0x05,0x23,1,0,0],rax:b=>BigInt.asUintN(32,b+8n+0x123n)},
  {name:'load-rip',source:[0x48,0x8b,0x05,8,0,0,0],rax:()=>0x1122334455667788n},
  {name:'call-relative',source:[0xe8,13,0,0,0],call:true},
  {name:'return-absolute',source:[0xc3],ret:true},
  {name:'divide',source:[0x48,0xf7,0xf3],divide:true},
  {name:'repeat',source:[0xf3,0xa4],repeat:true},
  {name:'jump-relative',source:[0xeb,0xfd],branchOffset:-1n},
  {name:'conditional-relative',source:[0x75,7],branchOffset:9n},
  {name:'lea-before-branch',source:[0x48,0x8d,0x43,0x19,0x75,7],instructions:2,rax:()=>28n,branchOffset:13n},
];
let templates=0,dispatchComparisons=0,entryRefusals=0,divideFaults=0;
let fetchFaults=0,continuations=0,legacyTypeRefusals=0;
async function emit(entry,example) {
  cold.fill(0x90,input,input+4096);cold.set(example.source,input);
  assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,example.instructions||1,output,65536,report),0,example.name);
  assert.equal(cv.getBigUint64(report+32,true),BigInt(example.source.length));
  return Buffer.from(cold.subarray(output,output+Number(cv.getBigUint64(report+40,true))));
}
function reset(entry,example) {
  vm.vm_close();data.fill(0,base);
  for(let rank=0;rank<9;++rank) {
    const physical=BigInt((rank+1)*4096),at=directory+rank*32;
    put(at,physical);view.setUint32(at+8,Number(physical)+4096,true);
    view.setUint32(at+12,3,true);view.setUint32(at+16,1,true);data.fill(0,at+20,at+32);
  }
  let nextTable=0x2000n;
  function map(address,physical) {
    let table=0x1000n;
    for(const shift of [39n,30n,21n]) {
      const at=pageOffset(table)+Number(address>>shift&511n)*8;
      let pte=view.getBigUint64(at,true);
      if(!pte){assert(nextTable<codePhysical,'bounded test page tables');pte=nextTable|0x67n;nextTable+=4096n;put(at,pte);}
      table=pte&~4095n;
    }
    const at=pageOffset(table)+Number(address>>12n&511n)*8;put(at,physical|0x67n);return at;
  }
  const codePte=map(entry,codePhysical);map(stack,ramPhysical);
  const code=pageOffset(codePhysical),ram=pageOffset(ramPhysical);
  data.fill(0x90,code,code+4096);data.set(example.source,code);put(code+15,0x1122334455667788n);
  data.fill(0x93,ram,ram+4096);put(ram+512,0x600000n);
  for(let rank=0;rank<16;++rank)put(base+rank*8,BigInt(rank+1)*0xabcdefn);
  put(base,25);put(base+8,513);put(base+16,0);put(base+24,3);put(base+32,stack+512n);
  put(base+48,stack+2048n);put(base+56,stack+1024n);
  put(base+384,entry);put(base+392,0x10202);put(base+400,0x80010011);
  put(base+408,0x1000);put(base+416,32);put(base+424,0xd00);put(base+488,8);
  put(base+600,0x400);put(base+1128,41);put(port,9);
  view.setUint32(segments,2,true);view.setUint32(segments+36,0xa09b,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,directory,9,9,directory+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
  put(rows,entry);view.setUint32(rows+8,example.source.length,true);view.setUint32(rows+12,example.instructions||1,true);
  view.setUint32(rows+16,slot,true);view.setUint32(rows+20,cv.getUint32(report+76,true),true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  return {codePte,code,ram};
}
try {
  for(const example of examples) {
    const body=await emit(addresses[0],example);
    for(const entry of addresses)assert((await emit(entry,example)).equals(body),'one exact template: '+example.name);
    const cut=(await WebAssembly.instantiate(body,{machine:{memory,access:vm.vm_access}})).instance.exports.cut;
    vm.__indirect_function_table.set(slot,cut);++templates;
    for(const entry of addresses) {
      let {ram}=reset(entry,example);
      const expected=cpu(),image=Buffer.from(data.subarray(ram,ram+4096));
      expected.writeBigUInt64LE(entry+BigInt(example.source.length),384);
      expected.writeBigUInt64LE(0x202n,392);expected.writeBigUInt64LE(41n+BigInt(example.instructions||1),1128);
      if(example.branchOffset!==undefined)expected.writeBigUInt64LE(BigInt.asUintN(64,entry+example.branchOffset),384);
      if(example.rax)expected.writeBigUInt64LE(example.rax(entry),0);
      if(example.call){expected.writeBigUInt64LE(entry+18n,384);expected.writeBigUInt64LE(stack+504n,32);image.writeBigUInt64LE(entry+5n,504);}
      if(example.ret){expected.writeBigUInt64LE(0x600000n,384);expected.writeBigUInt64LE(stack+520n,32);}
      if(example.divide){expected.writeBigUInt64LE(8n,0);expected.writeBigUInt64LE(1n,16);}
      if(example.repeat){
        image.copy(image,1024,2048,2048+513);expected.writeBigUInt64LE(0n,8);
        expected.writeBigUInt64LE(stack+2048n+513n,48);expected.writeBigUInt64LE(stack+1024n+513n,56);
        assert.equal(vm.vm_run(port,9n,1),10n);
        put(rows,entry+4096n);view.setUint32(rows+16,0,true);
        // Growth refreshes only extent. It must not reconstruct/rebind the latch.
        if(entry===addresses[0]){memory.grow(1);data=Buffer.from(memory.buffer);view=new DataView(memory.buffer);assert.equal(vm.vm_grow(),0);}
        assert.equal(vm.vm_run(port,9n,1),10n);++continuations;
        // Payload writes revoke the directory, not the already completed REP.
        assert.equal(vm.vm_run(port,9n,1),5n);++continuations;
      }else assert.equal(vm.vm_run(port,9n,1),example.call?5n:1n,example.name);
      assert(cpu().equals(expected),example.name+': complete state at admitted coordinate');
      assert(data.subarray(ram,ram+4096).equals(image),example.name+': exact RAM');
      assert.equal(vm.vm_source_retired(),BigInt(example.instructions||1));++dispatchComparisons;
      reset(entry,example);
      const before=Buffer.from(data.subarray(base,base+4096));
      assert.equal(cut(base,port,entry+1n,cv.getUint32(report+76,true)),6n,'wrong independent binding refuses before mutation');
      assert(data.subarray(base,base+4096).equals(before));++entryRefusals;
      const {codePte}=reset(entry,example);put(codePte,0);
      const old=cpu();assert.equal(vm.vm_run(port,9n,1),115n);
      assert(cpu().equals(old));assert.equal(view.getUint32(port+24,true),14);
      assert.equal(view.getBigUint64(port+16,true),entry);assert.equal(vm.vm_source_retired(),0n);++fetchFaults;
      if(example.divide){
        reset(entry,example);put(base+24,0);const old=cpu();
        assert.equal(vm.vm_run(port,9n,1),3n);assert(cpu().equals(old));
        assert.equal(view.getBigUint64(port+16,true),entry);assert.equal(view.getUint32(port+24,true),0);
        assert.equal(vm.vm_source_retired(),0n);++divideFaults;
      }
    }
  }
  // Deliberately old two- and three-argument toys. A typed C indirect call must trap
  // before its observable store; no adapter can repair it into an accepted cut.
  const oldModule=Uint8Array.from([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,126,
    2,19,1,7,109,97,99,104,105,110,101,6,109,101,109,111,114,121,2,0,2,
    3,2,1,0,7,7,1,3,99,117,116,0,0,10,14,1,12,0,32,0,66,227,0,55,3,0,66,1,11]);
  const oldThree=Uint8Array.from([...oldModule.subarray(0,8),1,8,1,96,3,127,127,126,1,126,
    ...oldModule.subarray(17)]);
  for(const bytes of [oldModule,oldThree]){
    const oldCut=(await WebAssembly.instantiate(bytes,{machine:{memory}})).instance.exports.cut;
    reset(addresses[0],examples[0]);vm.__indirect_function_table.set(slot,oldCut);
    const before=cpu();assert.throws(()=>vm.vm_run(port,9n,1),WebAssembly.RuntimeError);
    assert(cpu().equals(before));assert.equal(vm.vm_source_retired(),0n);++legacyTypeRefusals;
  }
}finally{vm.__indirect_function_table.set(slot,null);vm.vm_close();cc.compiler_close();}
console.log(JSON.stringify({format:'c-wasm-entry-binding-v2',status:'pass',templates,dispatchComparisons,
  entryRefusals,divideFaults,fetchFaults,continuations,legacyTypeRefusals,
  oracle:'explicit coordinate/frontier models through C MMU; independent native instruction oracles remain separate',
  linuxBoot:'not-tested'},null,2));
