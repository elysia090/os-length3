// Region and fault models, driven by actual C compiler/MMU/table execution.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile]=process.argv.slice(2);
if(!compilerFile)throw new Error('VM.WASM COMPILER.WASM');
const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const dir=vm.vm_arena_min(),cpu=dir+4096,rows=dir+512,segments=cpu+1408,port=cpu+2048,codeView=port+64,entry=0x400000n;
const ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,payload=i=>cpu+(i+2)*4096,put=(at,x)=>v.setBigUint64(at,BigInt(x),true),table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));let comparisons=0,faults=0,waits=0,retries=0,success=0;
for(const width of [4,8])for(const kind of ['load','store','register','alias']){
  const mem=kind==='load'||kind==='store',store=kind==='store',source=Buffer.from([width===4?0xf3:0xf2,0x0f,store?0x11:0x10,kind==='load'?7:store?15:kind==='register'?0xc1:0xc0]);
  c.fill(0x90,ci,ci+4096);c.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);
  const binding=cv.getUint32(cr+76,true),cut=(await WebAssembly.instantiate(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))),{machine:{memory,access:vm.vm_access}})).instance.exports.cut;cc.compiler_close();
  for(const dispatch of [false,true])for(const emts of [0,4,8,12])for(const fx of [false,true])for(const pending of [false,true])for(const cross of [false,true])
  for(const problem of ['none','readonly','nonpresent','deferred']){
    vm.vm_close();a.fill(0,dir);
    [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000,0xa000].forEach((address,i)=>{
      put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
    put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2)+16,0x4067);put(payload(3),0x8067);put(payload(3)+8,0x9067);put(payload(3)+16,0xa067);
    const targetPage=cross?2:1;if(problem==='readonly')put(payload(3)+targetPage*8,BigInt((cross?0xa000:0x9000)|0x65));
    if(problem==='nonpresent')put(payload(3)+targetPage*8,0);
    if(problem==='deferred')v.setUint32(dir+(4+targetPage)*32+16,3,true);
    const address=cross?0x401fffn:0x401010n,at=payload(5)+Number(address-0x401000n);a.set(source,payload(4));put(at,0xfedcba9876543210n);
    put(cpu+56,address);put(cpu+128,0x5566778844332211n);put(cpu+136,0x9988776655443322n);put(cpu+144,0x0123456789abcdefn);put(cpu+152,0xf0e1d2c3b4a59687n);
    put(cpu+384,entry);put(cpu+392,0x10202);put(cpu+400,0x80010031|emts);put(cpu+408,0x1000);put(cpu+416,32|(fx?512:0));put(cpu+424,0x500);
    put(cpu+488,19);put(cpu+600,0x400);put(cpu+1128,42);v.setUint32(cpu+612,0x3f,true);v.setUint16(cpu+1232,pending?0x37e:0x37f,true);v.setUint16(cpu+1234,pending?0x8081:0x3800,true);
    put(port,9);v.setUint32(segments,2,true);v.setUint32(segments+36,0xa0fb,true);
    assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,7,7,dir+2048,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
    assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),cut);assert.equal(vm.vm_source_publish(source.length,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    const before=Buffer.from(a.subarray(cpu,cpu+1256)),expected=Buffer.from(before),old=Buffer.from(a.subarray(at,at+8));
    const fault=emts&4||!fx?6:emts&8?7:mem&&problem==='nonpresent'||store&&problem==='readonly'?14:0,wait=!fault&&mem&&problem==='deferred';
    function complete(){if(kind==='load'){const value=width===4?0x76543210n:0xfedcba9876543210n;expected.writeBigUInt64LE(value,128);expected.writeBigUInt64LE(0n,136);}
      else if(kind==='register'){width===4?expected.writeUInt32LE(0x89abcdef,128):expected.writeBigUInt64LE(0x0123456789abcdefn,128);}
      expected.writeBigUInt64LE(entry+BigInt(source.length),384);expected.writeBigUInt64LE(0x202n,392);expected.writeBigUInt64LE(43n,1128);}
    const result=dispatch?vm.vm_run(port,9n,1):cut(cpu,port,entry,binding);assert.equal(result,fault?BigInt(fault)*8n+3n:wait?2n:1n);
    if(fault){assert.equal(v.getUint32(port+24,true),fault);if(fault===14)assert.equal(v.getUint32(port+28,true),problem==='readonly'?7:store?6:4);++faults;}
    else if(wait)++waits;else{complete();++success;}
    assert(a.subarray(cpu,cpu+1256).equals(expected),`${width}/${kind}/${dispatch}/${emts}/${fx}/${pending}/${cross}/${problem}`);
    if(dispatch)assert.equal(vm.vm_source_retired(),fault||wait?0n:1n);
    if(!store||fault||wait)assert(a.subarray(at,at+8).equals(old));
    else{const bytes=Buffer.from(old);width===4?bytes.writeUInt32LE(0x89abcdef,0):bytes.writeBigUInt64LE(0x0123456789abcdefn,0);assert(a.subarray(at,at+8).equals(bytes));}
    if(wait&&dispatch){v.setUint32(dir+(4+targetPage)*32+16,1,true);const resumed=vm.vm_run(port,9n,1);assert.equal(resumed,1n,`retry ${width}/${kind}/${emts}/${fx}/${pending}/${cross}/${problem} retired=${vm.vm_source_retired()} completed=${vm.vm_completed()}`);complete();assert(a.subarray(cpu,cpu+1256).equals(expected));++retries;}
    ++comparisons;
  }
}
// The resumed path must still revoke an actual code mutation. Host RAM
// rights deny the store while allowing the executable source fetch; promotion
// changes only that same serialized descriptor, not guest PTEs or code bytes.
{
  const source=Buffer.from([0xf3,0x0f,0x11,15]);c.fill(0x90,ci,ci+4096);c.set(source,ci);
  assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);
  const binding=cv.getUint32(cr+76,true),cut=(await WebAssembly.instantiate(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))),{machine:{memory,access:vm.vm_access}})).instance.exports.cut;cc.compiler_close();
  vm.vm_close();a.fill(0,dir);[0x1000,0x2000,0x3000,0x4000,0x8000].forEach((address,i)=>{
    put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,i===4?1:3,true);v.setUint32(dir+i*32+16,1,true);});
  put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2)+16,0x4067);put(payload(3),0x8067);a.set(source,payload(4));
  put(cpu+56,entry);put(cpu+144,0x90909090);put(cpu+384,entry);put(cpu+392,0x10202);put(cpu+400,0x80010031);put(cpu+408,0x1000);put(cpu+416,544);put(cpu+424,0x500);put(cpu+488,19);put(cpu+600,0x400);put(cpu+1128,42);put(port,9);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa0fb,true);
  assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,5,5,dir+2048,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
  assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),cut);assert.equal(vm.vm_source_publish(source.length,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  const before=Buffer.from(a.subarray(cpu,cpu+1256));assert.equal(vm.vm_run(port,9n,1),2n);assert(a.subarray(cpu,cpu+1256).equals(before));assert(a.subarray(payload(4),payload(4)+4).equals(source));
  v.setUint32(dir+4*32+12,3,true);assert.equal(vm.vm_run(port,9n,1),5n);assert.equal(vm.vm_completed(),1);assert.equal(vm.vm_source_retired(),1n);
  assert.equal(v.getUint32(payload(4),true),0x90909090);assert.equal(v.getBigUint64(cpu+384,true),entry+4n);++comparisons;
}
vm.vm_close();console.log(JSON.stringify({status:'pass',comparisons,faults,waits,retries,success,codeMutationRevocations:1,scope:'C #UD/#NM, pending-x87 independence, exact region/zero-clear/store, readonly/cross-page/fault/wait/retry; direct + table models; resumed real-code write still revokes',linuxBoot:'not-tested'}));
