// Explicit fixed-platform absence through the generated x86 cut and C MMU.
// Not an 8237 engine, a physical-CPU I/O oracle, browser acceptance or Linux boot.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile]=process.argv.slice(2);
if(!compilerFile)throw new Error('usage: check-absent-dma.mjs VM.WASM COMPILER.WASM');
const memory=new WebAssembly.Memory({initial:16,maximum:18});
const coldMemory=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:coldMemory}})).instance.exports;
assert.equal(vm.vm_entry_abi(),2);assert.equal(cc.compiler_entry_abi(),2);
let data=Buffer.from(memory.buffer),view=new DataView(memory.buffer);
const cold=Buffer.from(coldMemory.buffer),cv=new DataView(coldMemory.buffer);
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const directory=vm.vm_arena_min(),rows=directory+512,base=directory+4096;
const port=base+2048,segments=base+1408,slot=vm.__indirect_function_table.grow(1);
const ports=[0x81,0x82,0x83,0x87,0x89,0x8a,0x8b,0x8f];
const codePhysical=0x8000n,tssPhysical=0x9000n,tssAddress=0x500000n;
const pageOffset=physical=>base+Number(physical)+4096;
const put=(at,x)=>view.setBigUint64(at,BigInt.asUintN(64,BigInt(x)),true);
const cpu=()=>Buffer.from(data.subarray(base,base+1256));
let emissions=0,comparisons=0,retirements=0,permissionFaults=0,widthRefusals=0;
let fetchFaults=0,staleRefusals=0,bindingRefusals=0,pendingRefusals=0,unknownRefusals=0;
let writeReadSequences=0;
function reset(entry,source,coordinate,cpl=0,iopl=0,deny=false){
  vm.vm_close();data.fill(0,base);
  for(let rank=0;rank<9;++rank){
    const physical=BigInt((rank+1)*4096),at=directory+rank*32;
    put(at,physical);view.setUint32(at+8,Number(physical)+4096,true);
    view.setUint32(at+12,3,true);view.setUint32(at+16,1,true);data.fill(0,at+20,at+32);
  }
  let nextTable=0x2000n;
  function map(address,physical){
    let table=0x1000n;
    for(const shift of [39n,30n,21n]){
      const at=pageOffset(table)+Number(address>>shift&511n)*8;
      let pte=view.getBigUint64(at,true);
      if(!pte){assert(nextTable<codePhysical);pte=nextTable|0x67n;nextTable+=4096n;put(at,pte);}
      table=pte&~4095n;
    }
    const at=pageOffset(table)+Number(address>>12n&511n)*8;put(at,physical|0x67n);return at;
  }
  const codePte=map(entry,codePhysical);map(tssAddress,tssPhysical);
  const code=pageOffset(codePhysical),tss=pageOffset(tssPhysical);
  data.fill(0x90,code,code+4096);data.set(source,code+Number(entry&4095n));
  for(let rank=0;rank<16;++rank)put(base+rank*8,BigInt(rank+1)*0xabcdef01234567n);
  put(base,0xfeedabcd98765432n);put(base+16,0xabcdef9800000000n+BigInt(coordinate));
  put(base+384,entry);put(base+392,0x10202|(iopl<<12));put(base+400,0x80010011);
  put(base+408,0x1000);put(base+416,32);put(base+424,0xd00);put(base+488,8|cpl);put(base+1128,41);
  put(port,9);put(port+8,0x123456789abcdef0n);
  view.setUint32(segments,2,true);view.setUint32(segments+36,0xa09b,true);
  put(segments+120,tssAddress);view.setUint32(segments+128,4095,true);view.setUint32(segments+132,0x8b,true);
  view.setUint16(tss+102,104,true);data[tss+104+(coordinate>>3)]=deny ? 1<<(coordinate&7) : 0;
  assert.equal(vm.vm_open(base,data.length-base,4096,directory,9,9,directory+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
  put(rows,entry);view.setUint32(rows+8,source.length,true);view.setUint32(rows+12,1,true);
  view.setUint32(rows+16,slot,true);view.setUint32(rows+20,0,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  return {codePte,tss};
}
async function emit(entry,source){
  cold.fill(0x90,input,input+4096);cold.set(source,input+Number(entry&4095n));
  assert.equal(cc.compiler_open_pages(input,1,entry&~4095n,9n),0);
  assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
  assert.equal(cv.getBigUint64(report+32,true),BigInt(source.length));
  const bytes=Buffer.from(cold.subarray(output,output+Number(cv.getBigUint64(report+40,true))));
  const cut=(await WebAssembly.instantiate(bytes,{machine:{memory,io:vm.vm_io}})).instance.exports.cut;
  assert.equal(cut.length,3);vm.__indirect_function_table.set(slot,cut);++emissions;return cut;
}
try{
  const entry=0x400000n;
  for(const coordinate of ports)for(const address32 of [false,true])
  for(const dynamic of [false,true])for(const write of [false,true])for(const width of [1,2,4]){
    const source=[...(address32?[0x67]:[]),...(width===2?[0x66]:[]),
      (dynamic?0xec:0xe4)|(write?2:0)|(width===1?0:1),...(dynamic?[]:[coordinate])];
    const cut=await emit(entry,source);
    for(let cpl=0;cpl<4;++cpl)for(let iopl=0;iopl<4;++iopl)for(const deny of [false,true]){
      const {tss}=reset(entry,source,coordinate,cpl,iopl,deny);
      const expected=cpu(),hidden=Buffer.from(data.subarray(segments,segments+136));
      const tssBefore=Buffer.from(data.subarray(tss,tss+4096));
      const denied=cpl>iopl && deny;
      const result=denied?107n:width===1?1n:6n;
      assert.equal(vm.vm_run(port,9n,1),result);
      if(result===1n){
        if(!write)expected.writeBigUInt64LE((expected.readBigUInt64LE(0)&~255n)|255n,0);
        expected.writeBigUInt64LE(entry+BigInt(source.length),384);
        expected.writeBigUInt64LE(expected.readBigUInt64LE(392)&~0x10000n,392);
        expected.writeBigUInt64LE(42n,1128);++retirements;
      }else if(denied){
        assert.equal(view.getBigUint64(port+16,true),entry);assert.equal(view.getUint32(port+24,true),13);
        assert.equal(view.getUint32(port+28,true),0);++permissionFaults;
      }else ++widthRefusals;
      assert(cpu().equals(expected));assert(data.subarray(segments,segments+136).equals(hidden));
      assert(data.subarray(tss,tss+4096).equals(tssBefore));
      assert.equal(vm.vm_completed(),result===1n?1:0);assert.equal(vm.vm_source_retired(),result===1n?1n:0n);
      ++comparisons;
    }
    reset(entry,source,coordinate);let before=cpu();
    assert.equal(cut(base,port,entry+1n),6n);assert(cpu().equals(before));++bindingRefusals;
    const {codePte}=reset(entry,source,coordinate);before=cpu();put(codePte,0);
    assert.equal(vm.vm_run(port,9n,1),115n);assert(cpu().equals(before));
    assert.equal(view.getBigUint64(port+16,true),entry);assert.equal(view.getUint32(port+24,true),14);++fetchFaults;
    reset(entry,source,coordinate);before=cpu();put(port,8);
    assert.equal(vm.vm_run(port,9n,1),5n);assert(cpu().equals(before));++staleRefusals;
    reset(entry,source,coordinate);before=cpu();assert.equal(vm.vm_time(port),18n);
    const ticket=view.getBigUint64(port+32,true);
    assert.equal(vm.vm_run(port,9n,1),6n);assert(cpu().equals(before));
    assert.equal(view.getBigUint64(port+32,true),ticket);++pendingRefusals;
    if(emissions===96){memory.grow(1);data=Buffer.from(memory.buffer);view=new DataView(memory.buffer);assert.equal(vm.vm_grow(),0);}
  }
  // The actual stopped opcode/coordinate, without changing a kernel byte.
  const actualEntry=0xffffffff81405c2bn,source=[0xe4,0x87];await emit(actualEntry,source);
  reset(actualEntry,source,0x87);const expected=cpu();
  expected.writeBigUInt64LE((expected.readBigUInt64LE(0)&~255n)|255n,0);
  expected.writeBigUInt64LE(actualEntry+2n,384);expected.writeBigUInt64LE(0x202n,392);expected.writeBigUInt64LE(42n,1128);
  assert.equal(vm.vm_run(port,9n,1),1n);assert(cpu().equals(expected));++comparisons;++retirements;
  // OUT then IN without reopen: discarded writes must not create a latch.
  // Both rows are compiled normally and receive separate admitted coordinates.
  const readSlot=vm.__indirect_function_table.grow(1);
  try{
    for(const coordinate of ports){
      const out=[0xe6,coordinate],ins=[0xe4,coordinate],source=[...out,...ins];
      const outCut=await emit(entry,out),inCut=await emit(entry+2n,ins);
      vm.__indirect_function_table.set(slot,outCut);vm.__indirect_function_table.set(readSlot,inCut);
      for(let value=0;value<256;++value){
        reset(entry,source,coordinate);put(base,0xfeedabcd98765400n|BigInt(value));
        view.setUint32(rows+8,2,true);put(rows+24,entry+2n);
        view.setUint32(rows+32,2,true);view.setUint32(rows+36,1,true);
        view.setUint32(rows+40,readSlot,true);view.setUint32(rows+44,0,true);
        assert.equal(vm.vm_bind_execution(rows,2,9n),0);
        const expected=cpu();expected.writeBigUInt64LE(0xfeedabcd987654ffn,0);
        expected.writeBigUInt64LE(entry+4n,384);expected.writeBigUInt64LE(0x202n,392);expected.writeBigUInt64LE(43n,1128);
        assert.equal(vm.vm_run(port,9n,2),1n);assert(cpu().equals(expected));
        assert.equal(vm.vm_completed(),2);assert.equal(vm.vm_source_retired(),2n);++writeReadSequences;
      }
    }
  }finally{vm.__indirect_function_table.set(readSlot,null);}
  for(const coordinate of [0x84,0x85,0x86,0x88,0x8c,0x8d,0x8e,0x97])for(const write of [false,true]){
    const source=[write?0xe6:0xe4,coordinate];await emit(entry,source);reset(entry,source,coordinate);
    const before=cpu();assert.equal(vm.vm_run(port,9n,1),6n);assert(cpu().equals(before));++unknownRefusals;
  }
}finally{vm.__indirect_function_table.set(slot,null);vm.vm_close();cc.compiler_close();}
console.log(JSON.stringify({format:'c-wasm-absent-isa-dma-v1',status:'pass',emissions,comparisons,
  retirements,permissionFaults,widthRefusals,fetchFaults,staleRefusals,bindingRefusals,pendingRefusals,unknownRefusals,writeReadSequences,
  oracle:'fixed-platform absent page-port contract and x86 permission/frontier models; no system-mode hardware comparison',
  browserAcceptance:'not-tested',linuxBoot:'not-tested'},null,2));
