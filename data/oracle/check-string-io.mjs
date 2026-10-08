// Native/reference-system records -> actual C compiler/MMU/device/table.
// Supervisor fixture loading only; no JS port or guest instruction emulator.
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import path from 'node:path';
const [vmFile,compilerFile,directory]=process.argv.slice(2);if(!directory)throw new Error('VM.WASM COLD.WASM REFERENCE-STRING-IO-RECORDS');
const memory=new WebAssembly.Memory({initial:32}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports,cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),dir=vm.vm_arena_min(),cpu=dir+4096,
  rows=dir+2048,branches=dir+3072,port=cpu+2048,segments=cpu+1408,codeView=port+64,reserved=131072,
  ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,entry=0x400000n;
const put=(at,x)=>v.setBigUint64(at,BigInt.asUintN(64,BigInt(x)),true),payload=i=>cpu+reserved+i*4096;
const table=vm.__indirect_function_table;table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));
const initialRam=Buffer.alloc(8192);for(let i=0;i<initialRam.length;++i)initialRam[i]=(i*13+0x5b)&255;
let comparisons=0,faults=0,deniedOnly=false;
for(let form=0;form<72;++form){const file=suffix=>readFile(path.join(directory,`string-io-${form}.${suffix}`));
  const meta=JSON.parse(await file('json')),source=await file('source'),native=await file('cases');assert.equal(meta.recordBytes,440);assert.equal(native.length,64*440);
  deniedOnly=!!meta.deniedOnly;
  c.fill(0x90,ci,ci+4096);c.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0,`string IO ${form} must compile`);
  const binding=cv.getUint32(cr+76,true),n=Number(cv.getBigUint64(cr+40,true)),instance=(await WebAssembly.instantiate(c.subarray(co,co+n),
    {machine:{memory,io:vm.vm_io,access:vm.vm_access,checkpoint:vm.vm_checkpoint}})).instance;cc.compiler_close();
  for(let row=0;row<64;++row){vm.vm_close();a.fill(0,dir);const record=native.subarray(row*440,(row+1)*440),phase=(row>>2)&7;
    const physical=[0x1000,0x2000,0x3000,0x4000,0x5000,0x8000,0x9000,0x10000,0x11000];
    physical.forEach((address,i)=>{put(dir+i*32,address);v.setUint32(dir+i*32+8,reserved+i*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
    put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2)+16,0x4067);put(payload(2)+Number((0x12340000n>>21n)&511n)*8,0x5067);
    put(payload(3),0x8067);put(payload(3)+256*8,0x9067);const ramIndex=Number((0x12340000n>>12n)&511n);
    put(payload(4)+ramIndex*8,phase===6?0x10065:0x10067);put(payload(4)+(ramIndex+1)*8,phase===1||phase===4?0:0x11067);
    a.fill(0x90,payload(5),payload(5)+4096);a.set(source,payload(5));a.fill(0xff,payload(6),payload(6)+4096);
    v.setUint16(payload(6)+102,104,true);a[payload(6)+104+93]=!meta.deniedOnly&&(row&1)?0xf0:0xff;a.set(initialRam,payload(7));
    a.set(record.subarray(0,128),cpu);put(cpu+384,entry);put(cpu+392,record.readBigUInt64LE(128));put(cpu+400,0x80010031);
    put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0xd00);put(cpu+488,3);put(cpu+600,0x400);put(cpu+1128,42);put(port,9);
    v.setUint32(segments,2,true);v.setUint32(segments+36,0xa0fb,true);put(segments+8+7*16,0x500000);
    v.setUint32(segments+8+7*16+8,4095,true);v.setUint32(segments+8+7*16+12,0x8b,true);
    assert.equal(vm.vm_open(cpu,a.length-cpu,reserved,dir,physical.length,physical.length,branches,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
    assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),instance.exports.cut);
    assert.equal(vm.vm_source_publish(source.length,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    const result=vm.vm_run(port,9n,1),vector=record.readBigUInt64LE(280);assert.equal(result,vector?vector*8n+3n:1n,`string IO result ${form}/${row}`);
    for(let r=0;r<16;++r)assert.equal(v.getBigUint64(cpu+r*8,true),record.readBigUInt64LE(136+r*8),`string IO GPR ${form}/${row}/${r}`);
    assert.equal(v.getBigUint64(cpu+392,true),record.readBigUInt64LE(264));assert.equal(v.getBigUint64(cpu+384,true),record.readBigUInt64LE(272));
    if(vector){assert.equal(v.getUint32(port+24,true),Number(vector));assert.equal(v.getUint32(port+28,true),Number(record.readBigUInt64LE(288)));if(vector===14n)assert.equal(v.getBigUint64(port+16,true),record.readBigUInt64LE(296));++faults;}
    const expected=Buffer.from(initialRam),changed=Number(record.readBigUInt64LE(304));assert(changed<=16);
    for(let i=0;i<changed;++i)expected[record.readUInt32LE(312+i*8)]=record.readUInt32LE(316+i*8);
    assert(a.subarray(payload(7),payload(7)+8192).equals(expected),`string IO RAM ${form}/${row}`);++comparisons;
  }
}
vm.vm_close();console.log(JSON.stringify({format:'reference-string-io-c-v1',status:'pass',comparisons,faults,
  oracle:deniedOnly?'reference WHPX denied-only records; no permitted device access':'independent QEMU TCG reference-system records; not product backend',linuxBoot:'not-tested'},null,2));
