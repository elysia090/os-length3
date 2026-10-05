// Independent native observation bytes, exact cold-C emission, actual C MMU.
// No JavaScript memory instruction or FPU opcode callback is used here.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [providerFile,compilerFile,directory]=process.argv.slice(2);
if(!directory)throw new Error('usage: node check-fxsave.mjs VM.wasm COMPILER.wasm NATIVE-DIRECTORY');
const memory=new WebAssembly.Memory({initial:8});
const vm=(await WebAssembly.instantiate(await readFile(providerFile),{machine:{memory}})).instance.exports;
const coldMemory=new WebAssembly.Memory({initial:16});
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:coldMemory}})).instance.exports;
const cold=Buffer.from(coldMemory.buffer),cv=new DataView(coldMemory.buffer);
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const data=Buffer.from(memory.buffer),view=new DataView(memory.buffer);
const directoryAt=vm.vm_arena_min(),rows=directoryAt+512,base=directoryAt+4096;
const port=base+2048,segments=base+1408,entry=0x400000n,code=base+28672,payload=base+32768;
const slot=vm.__indirect_function_table.grow(1),stride=2*1256+1024;
const put=(at,value)=>view.setBigUint64(at,BigInt(value),true);
const cpu=()=>Buffer.from(data.subarray(base,base+1256));
let comparisons=0,direct=0,parity=0,faults=0,refusals=0,waits=0,profileModels=0;
function reset(source,meta,record,{mode,mask=0,rf=0n,unaligned=false,noncanonical=false}={}) {
  data.fill(0,base); data.set(record.subarray(0,1256),base);
  put(base+392,view.getBigUint64(base+392,true)|rf);
  if(mask)put(base+400,view.getBigUint64(base+400,true)|BigInt(mask));
  const addresses=[0x1000,0x2000,0x3000,0x4000,0x5000,0x8000,0x9000,0xa000];
  for(const [rank,address]of addresses.entries()) {
    const at=directoryAt+rank*32; put(at,address); view.setUint32(at+8,(rank+2)*4096,true);
    view.setUint32(at+12,3,true); view.setUint32(at+16,mode==='deferred'&&rank===7?3:1,true);
    data.fill(0,at+20,at+32);
  }
  const address=BigInt(meta.address),pd=Number((address>>21n)&511n),pt=Number((address>>12n)&511n);
  assert.equal(address&4095n,0n); assert(pd!==2 && pt<511);
  put(base+8192,0x2067); put(base+12288+Number((address>>30n)&511n)*8,0x3067);
  put(base+12288,0x3067); put(base+16384+2*8,0x4067); put(base+16384+pd*8,0x5067);
  put(base+20480,0x8067); put(base+24576+pt*8,0x9067);
  put(base+24576+(pt+1)*8,mode==='absent'?0:mode==='readonly'?0xa065:0xa067);
  data.set(source,code);
  const addressReg=source[0]===0x41||source[0]===0x49?8:source[2]===0x45?5:7;
  if(unaligned)put(base+addressReg*8,view.getBigUint64(base+addressReg*8,true)+1n);
  if(noncanonical)put(base+addressReg*8,0x800000000000n);
  // SIB and extended forms have different bases. The native row parity fixes
  // the actual output coordinate independently of the lowering equations.
  const rowOutput=record.readBigUInt64LE(addressReg*8)
    +(source[2]===0x47?16n:source[2]===0x44?80n:0n);
  const imageOffset=Number(rowOutput-address);
  data.fill(0x93,payload,payload+8192); data.set(record.subarray(2512,3024),payload+imageOffset);
  put(port,mode==='stale'?8:9);
  view.setUint32(segments,2,true); view.setUint32(segments+36,0xa0fb,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,directoryAt,8,8,directoryAt+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
  put(rows,entry); view.setUint32(rows+8,meta.sourceBytes,true); view.setUint32(rows+12,1,true);
  view.setUint32(rows+16,slot,true); view.setUint32(rows+20,0,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  return imageOffset;
}
try {
  for(let form=0;form<8;++form) {
    const fixture=path.join(directory,`fxsave-${form}`),meta=JSON.parse(await readFile(`${fixture}.json`));
    const source=await readFile(`${fixture}.source-page`),emitted=await readFile(`${fixture}.wasm`),records=await readFile(`${fixture}.cases`);
    assert.equal(records.length,meta.native*stride); assert.equal(meta.stateBytes,1256);
    cold.set(source,input); assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,8,output,65536,report),0);
    assert.equal(cv.getBigUint64(report+40,true),BigInt(emitted.length));
    assert(cold.subarray(output,output+emitted.length).equals(emitted)); ++parity;
    const module=await WebAssembly.compile(emitted);
    assert.deepEqual(WebAssembly.Module.imports(module),[
      {module:'machine',name:'memory',kind:'memory'},
      ...['write_begin','write_word','write_end'].map(name=>({module:'machine',name,kind:'function'}))]);
    const cut=(await WebAssembly.instantiate(module,{machine:{memory,
      write_begin:vm.vm_write_begin,write_word:vm.vm_write_word,write_end:vm.vm_write_end}})).exports.cut;
    vm.__indirect_function_table.set(slot,cut);
    for(let row=0;row<meta.native;++row) {
      const record=records.subarray(row*stride,(row+1)*stride),expected=record.subarray(1256,2512);
      for(const dispatch of [false,true])for(const rf of [0n,0x10000n]) {
        const at=reset(source,meta,record,{rf}),oldPayload=Buffer.from(data.subarray(payload,payload+8192));
        const expectedPayload=Buffer.from(oldPayload); record.copy(expectedPayload,at,3024,3536);
        assert.equal(dispatch?vm.vm_run(port,9n,1):cut(base,port,entry),dispatch?5n:1n,`${form}/${row}: execute`);
        if(dispatch){assert.equal(vm.vm_completed(),1);assert.equal(vm.vm_source_retired(),1n);}
        assert(cpu().equals(expected),`${form}/${row}: complete CPU`);
        assert(data.subarray(payload,payload+8192).equals(expectedPayload),`${form}/${row}: whole output/neighbor bytes`);
        if(dispatch)++comparisons;else ++direct;
      }
    }
    const record=records.subarray(stride,2*stride); // cross-page native row
    for(const dispatch of [false,true])for(const rf of [0n,0x10000n])for(const scenario of [
      {mode:'absent',vector:14,error:6},{mode:'readonly',vector:14,error:7},
      {mode:'absent',mask:4,vector:7,error:0},{mode:'absent',mask:8,vector:7,error:0},
      {mode:'absent',mask:12,vector:7,error:0},{mode:'absent',unaligned:true,vector:13,error:0},
      ...form===3?[]:[{mode:'absent',noncanonical:true,vector:form===2?12:13,error:0}],
    ]) {
      reset(source,meta,record,{...scenario,rf}); const before=cpu(),oldPayload=Buffer.from(data.subarray(payload,payload+8192));
      assert.equal(dispatch?vm.vm_run(port,9n,1):cut(base,port,entry),(BigInt(scenario.vector)<<3n)|3n,`${form}: ${JSON.stringify(scenario)}`);
      assert(cpu().equals(before)); assert(data.subarray(payload,payload+8192).equals(oldPayload));
      assert.equal(view.getUint32(port+24,true),scenario.vector); assert.equal(view.getUint32(port+28,true),scenario.error); ++faults;
    }
    for(const dispatch of [false,true]) {
      reset(source,meta,record,{mode:'deferred'}); const before=cpu(),oldPayload=Buffer.from(data.subarray(payload,payload+8192));
      assert.equal(dispatch?vm.vm_run(port,9n,1):cut(base,port,entry),2n);
      assert(cpu().equals(before)); assert(data.subarray(payload,payload+8192).equals(oldPayload));
      assert.equal(view.getBigUint64(port+32,true),0xa000n); ++waits;
      // Supply this exact deferred physical descriptor, not repair guest PTEs.
      view.setUint32(directoryAt+7*32+16,1,true);
      const expectedPayload=Buffer.from(oldPayload);
      const addressReg=form===2?5:form===4||form===5?8:7;
      const at=Number(record.readBigUInt64LE(addressReg*8)-BigInt(meta.address))
        +(form===6?16:form===7?80:0);
      record.copy(expectedPayload,at,3024,3536);
      assert.equal(dispatch?vm.vm_run(port,9n,1):cut(base,port,entry),dispatch?5n:1n);
      if(dispatch){assert.equal(vm.vm_completed(),1);assert.equal(vm.vm_source_retired(),1n);}
      assert(cpu().equals(record.subarray(1256,2512)));
      assert(data.subarray(payload,payload+8192).equals(expectedPayload)); ++waits;
      reset(source,meta,record,{mode:'stale'}); const stale=cpu();
      assert.equal(vm.vm_run(port,9n,1),5n); assert(cpu().equals(stale)); ++refusals;
    }
    for(const badPort of [port+1,base,base+8,base+1248,data.length-24,-1]) {
      reset(source,meta,record); const before=cpu(),oldPayload=Buffer.from(data.subarray(payload,payload+8192));
      assert.equal(cut(base,badPort,entry),6n); assert(cpu().equals(before));
      assert(data.subarray(payload,payload+8192).equals(oldPayload)); ++refusals;
    }
    for(const badState of [base+1,0xfffffff8,data.length-1248]) {
      reset(source,meta,record); const before=cpu(); assert.equal(cut(badState,port,entry),6n);
      assert(cpu().equals(before)); ++refusals;
    }
    // OSFXSR=0 is implementation dependent for the SIMD portion. This fixed
    // CPU profile chooses the same complete save, not an implicit #UD.
    const at=reset(source,meta,record); put(base+416,32n);
    const expected=Buffer.from(record.subarray(1256,2512)); expected.writeBigUInt64LE(32n,416);
    const expectedPayload=Buffer.from(data.subarray(payload,payload+8192));
    record.copy(expectedPayload,at,3024,3536);
    assert.equal(cut(base,port,entry),1n);
    assert(cpu().equals(expected)); assert(data.subarray(payload,payload+8192).equals(expectedPayload));
    ++profileModels;
  }
}finally{vm.__indirect_function_table.set(slot,null);vm.vm_close();}
console.log(JSON.stringify({status:'pass',nativeColdParity:parity,directComparisons:direct,
  dispatchComparisons:comparisons,preciseFaultModels:faults,waitRetryModels:waits,entryRefusals:refusals,
  osfxsrProfileModels:profileModels,
  oracle:'native x86 instruction images in reference build VM; MMU fault models, not physical hardware',linuxBoot:'not-tested'}));
