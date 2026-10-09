// Native process LDT bytes/RAX/RFLAGS -> actual C compiler/MMU/table. Hidden
// caches are a declared mirror transport, not claimed native cache measurements.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,compilerFile,directory]=process.argv.slice(2);
if(!directory)throw new Error('VM.WASM COMPILER.WASM NATIVE-DIRECTORY');
const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,dir=vm.vm_arena_min(),cpu=dir+4096,rows=dir+512,segments=cpu+1408,port=cpu+2048,codeView=port+64;
const entry=0x400000n,put=(at,x)=>v.setBigUint64(at,BigInt(x),true),table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));let comparisons=0,undefinedNibbleDifferences=0;
for(let form=0;form<12;++form){const file=suffix=>readFile(path.join(directory,`selector-query-${form}.${suffix}`));
  const meta=JSON.parse(await file('json')),source=await file('source'),native=await file('cases'),descriptors=await file('descriptors'),selectors=await file('selectors');
  assert.equal(meta.stateBytes,1256);assert.equal(native.length,meta.native*2512);assert.equal(descriptors.length,meta.native*8);assert.equal(selectors.length,meta.native*2);
  c.fill(0x90,ci,ci+4096);c.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);
  const binding=cv.getUint32(cr+76,true),cut=(await WebAssembly.instantiate(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))),
    {machine:{memory,access:vm.vm_access,descriptor:vm.vm_descriptor,checkpoint:vm.vm_checkpoint}})).instance.exports.cut;cc.compiler_close();
  for(let row=0;row<meta.native;++row){vm.vm_close();a.fill(0,dir);
    [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000,0xa000,0xb000,0xc000].forEach((address,i)=>{
      put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
    const payload=i=>cpu+(i+2)*4096;
    put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2)+16,0x4067);
    for(let p=0;p<5;++p)put(payload(3)+p*8,BigInt(0x8067+p*4096));
    const before=Buffer.from(native.subarray(row*2512,row*2512+1256)),after=Buffer.from(native.subarray(row*2512+1256,(row+1)*2512));
    for(const state of [before,after]){assert.equal(state.readBigUInt64LE(448),0x406000n);assert.equal(state.readBigUInt64LE(456),63n);assert.equal(state.readBigUInt64LE(528),0x50n);}
    a.set(before,cpu);a.set(source,payload(4));a.set(selectors.subarray(row*2,row*2+2),payload(5));
    const selector=selectors.readUInt16LE(row*2),offset=selector&0xfff8;if(offset<4096)a.set(descriptors.subarray(row*8,row*8+8),payload(7)+offset);
    put(port,9);v.setUint32(segments,2,true);v.setUint32(segments+36,0xa0fb,true);
    put(segments+8+6*16,0x403000);v.setUint32(segments+8+6*16+8,4095,true);v.setUint32(segments+8+6*16+12,0x82,true);
    assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,9,9,dir+2048,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
    assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),cut);
    assert.equal(vm.vm_source_publish(meta.sourceBytes,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    const result=vm.vm_run(port,9n,1);assert.equal(result,1n);assert.equal(vm.vm_source_retired(),1n);assert.equal(vm.vm_completed(),1);
    const actual=Buffer.from(a.subarray(cpu,cpu+1256));
    if(!meta.limit&&meta.width>=4&&(after.readBigUInt64LE(392)&64n)){
      // Intel explicitly leaves LAR bits19:16 undefined. Preserve the receipt
      // and count differences; compare the documented architectural frontier.
      if((actual.readBigUInt64LE(0)^after.readBigUInt64LE(0))&0xf0000n)++undefinedNibbleDifferences;
      actual.writeBigUInt64LE(actual.readBigUInt64LE(0)&~0xf0000n,0);after.writeBigUInt64LE(after.readBigUInt64LE(0)&~0xf0000n,0);
    }
    assert(actual.equals(after),`selector query ${form}/${row}: ${Array.from(after.entries()).filter(([n,b])=>actual[n]!==b).slice(0,16).map(([n,b])=>`${n}:${actual[n].toString(16)}/${b.toString(16)}`)}`);
    ++comparisons;
  }
}
vm.vm_close();console.log(JSON.stringify({status:'pass',comparisons,undefinedNibbleDifferences,
  scope:'WHPX native Linux process LDT readback/RAX/RFLAGS; other register invariance architectural; declared hidden-cache mirror, C compiler/MMU/table',linuxBoot:'not-tested'}));
