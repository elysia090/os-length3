// Execute compiled ENTER through the actual C MMU/table. Expected CPU and
// touched bytes are independent native records, not a JS guest interpreter.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,compilerFile,directory]=process.argv.slice(2);if(!directory)throw new Error('VM.WASM COLD.WASM NATIVE-ENTER-RECORDS');
const memory=new WebAssembly.Memory({initial:64}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const dir=vm.vm_arena_min(),cpu=dir+4096,rows=dir+2048,branches=dir+3072,port=cpu+2048,segments=cpu+1408,codeView=port+64,reserved=131072;
const ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,entry=0x400000n,ramBase=0x12340000n;
const put=(at,x)=>v.setBigUint64(at,BigInt.asUintN(64,BigInt(x)),true),payload=i=>cpu+reserved+i*4096;
const table=vm.__indirect_function_table;table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));
const initialRam=Buffer.alloc(131072);for(let i=0;i<initialRam.length;++i)initialRam[i]=(i*13+0x5b)&255;
let comparisons=0,faults=0,modules=0,waits=0;
for(let form=0;form<672;++form){const file=suffix=>readFile(path.join(directory,`enter-${form}.${suffix}`));
  const meta=JSON.parse(await file('json')),source=await file('source'),native=await file('cases');
  assert.equal(meta.recordBytes,568);assert.equal(native.length,meta.native*568);
  c.fill(0x90,ci,ci+4096);c.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0,`ENTER ${form} must compile`);
  const binding=cv.getUint32(cr+76,true),code=c.subarray(co,co+Number(cv.getBigUint64(cr+40,true)));
  const instance=(await WebAssembly.instantiate(code,{machine:{memory,access:vm.vm_access,checkpoint:vm.vm_checkpoint,
    write_begin:vm.vm_write_begin,write_end:vm.vm_write_end}})).instance;++modules;cc.compiler_close();
  for(let phase=0;phase<meta.native;++phase){vm.vm_close();a.fill(0,dir);const record=native.subarray(phase*568,(phase+1)*568);
    const physical=[0x1000,0x2000,0x3000,0x4000,0x5000,0x8000,...Array.from({length:32},(_,i)=>0x10000+i*4096)];
    physical.forEach((address,i)=>{put(dir+i*32,address);v.setUint32(dir+i*32+8,reserved+i*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
    put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2)+2*8,0x4067);put(payload(2)+Number((ramBase>>21n)&511n)*8,0x5067);
    put(payload(3),0x8067);for(let i=0;i<32;++i)put(payload(4)+Number(((ramBase>>12n)+BigInt(i))&511n)*8,BigInt(0x10067+i*4096));
    const missingPage=meta.bytes===8&&meta.allocation<=16&&(meta.nestingRaw&31)>=22&&phase>=10?(phase===10?6:7):-1;
    if(missingPage>=0)v.setUint32(dir+(6+missingPage)*32+16,3,true); // Test-only initial deferred descriptor.
    const protect=(page,flags)=>put(payload(4)+Number(((ramBase>>12n)+BigInt(page))&511n)*8,flags?BigInt(0x10000+page*4096)|BigInt(flags):0n);
    if(phase===3)protect(23,0x65);if(phase===4)protect(3,0);if(phase===5)protect(7,0x65);
    const sp=record.readBigUInt64LE(32),level=meta.nestingRaw&31,consumed=meta.bytes*(level?level+1:1);
    if(phase===6)protect(Number((sp-BigInt(consumed+meta.allocation)-ramBase)>>12n),0x65);
    if(phase===9&&meta.allocation>=4096)protect(9,0x65);
    a.fill(0x90,payload(5),payload(5)+4096);a.set(source,payload(5));
    a.set(initialRam,payload(6));
    a.set(record.subarray(0,128),cpu);put(cpu+384,entry);put(cpu+392,record.readBigUInt64LE(128));put(cpu+400,0x80010031);
    put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0xd00);put(cpu+488,3);put(cpu+600,0x400);put(cpu+1128,42);put(port,9);
    v.setUint32(segments,2,true);v.setUint32(segments+36,0xa0fb,true);
    assert.equal(vm.vm_open(cpu,a.length-cpu,reserved,dir,physical.length,physical.length,branches,9n),0);
    assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
    assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),instance.exports.cut);
    assert.equal(vm.vm_source_publish(source.length,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    let result=vm.vm_run(port,9n,1);const vector=record.readBigUInt64LE(280);
    if(missingPage>=0){assert.equal(result,2n,'resource wait after earlier transfers');assert.equal(v.getBigUint64(cpu+384,true),entry);
      assert.equal(v.getBigUint64(cpu+1128,true),42n);assert.equal(v.getBigUint64(cpu+32,true),sp);
      assert(!a.subarray(payload(6),payload(6)+131072).equals(initialRam),'wait must retain prior native-visible RAM writes');
      // Synthetic RAM fixture only: publish the already owned physical page,
      // not a production storage/authentication claim or a reopen/refetch.
      v.setUint32(dir+(6+missingPage)*32+16,1,true);result=vm.vm_run(port,9n,1);++waits;}
    assert.equal(result,vector?vector*8n+3n:missingPage>=0?5n:1n,`ENTER result ${form}/${phase}`);
    if(missingPage>=0&&!vector)assert.equal(vm.vm_source_retired(),1n,'latched completion retires once despite ordinary admission revocation');
    for(let reg=0;reg<16;++reg)assert.equal(v.getBigUint64(cpu+reg*8,true),record.readBigUInt64LE(136+reg*8),`ENTER GPR ${form}/${phase}/${reg}`);
    assert.equal(v.getBigUint64(cpu+392,true),record.readBigUInt64LE(264),`ENTER flags ${form}/${phase}`);
    assert.equal(v.getBigUint64(cpu+384,true),record.readBigUInt64LE(272));
    assert.equal(v.getBigUint64(cpu+1128,true),vector?42n:43n);
    if(vector){assert.equal(v.getUint32(port+24,true),Number(vector));assert.equal(v.getUint32(port+28,true),Number(record.readBigUInt64LE(288)));
      if(vector===14n)assert.equal(v.getBigUint64(port+16,true),record.readBigUInt64LE(296),`ENTER fault address ${form}/${phase}`);++faults;}
    const window=record.readBigUInt64LE(304),expected=record.subarray(312,568);
    const ram=a.subarray(payload(6),payload(6)+131072);
    if(window){const start=Number(window-ramBase);assert(start>=0&&start+256<=initialRam.length);
      assert(ram.subarray(0,start).equals(initialRam.subarray(0,start)),`ENTER RAM prefix ${form}/${phase}`);
      assert(ram.subarray(start,start+256).equals(expected),`ENTER RAM window ${form}/${phase}`);
      assert(ram.subarray(start+256).equals(initialRam.subarray(start+256)),`ENTER RAM suffix ${form}/${phase}`);
    }else assert(ram.equals(initialRam),`ENTER RAM ${form}/${phase}`);
    ++comparisons;
  }
}
vm.vm_close();console.log(JSON.stringify({format:'native-enter-c-v1',status:'pass',comparisons,faults,modules,waits,
  oracle:'independent native reference x86 build VM; CPU plus partial stack RAM',linuxBoot:'not-tested'},null,2));
