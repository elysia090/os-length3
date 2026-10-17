// Side-effecting C UART and C resource/console barriers around compiled I/O.
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile]=process.argv.slice(2),memory=new WebAssembly.Memory({initial:32}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports,cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),dir=vm.vm_arena_min(),cpu=dir+4096,
  rows=dir+2048,branches=dir+3072,port=cpu+2048,segments=cpu+1408,codeView=port+64,reserved=131072,ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536;
const entry=0x400000n,put=(at,x)=>v.setBigUint64(at,BigInt(x),true),payload=i=>cpu+reserved+i*4096,table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));
async function start(source,input){vm.vm_close();a.fill(0,dir);
  const physical=[0x1000,0x2000,0x3000,0x4000,0x5000,0x8000,0x10000];
  physical.forEach((address,i)=>{put(dir+i*32,address);v.setUint32(dir+i*32+8,reserved+i*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,input&&i===6?3:1,true);});
  put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2)+16,0x4067);put(payload(2)+Number((0x12340000n>>21n)&511n)*8,0x5067);
  put(payload(3),0x8067);put(payload(4)+Number((0x12340000n>>12n)&511n)*8,0x10067);a.fill(0x90,payload(5),payload(5)+4096);a.set(source,payload(5));
  put(cpu+16,0x3f8);put(cpu+48,0x12340100);put(cpu+56,0x12340100);put(cpu+384,entry);put(cpu+392,0x3202);put(cpu+400,0x80010031);
  put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0xd00);put(cpu+488,3);put(cpu+600,0x400);put(cpu+1128,42);put(port,9);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa0fb,true);
  assert.equal(vm.vm_open(cpu,a.length-cpu,reserved,dir,7,7,branches,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
  c.fill(0x90,ci,ci+4096);c.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);
  const binding=cv.getUint32(cr+76,true),instance=(await WebAssembly.instantiate(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))),
    {machine:{memory,io:vm.vm_io,access:vm.vm_access,checkpoint:vm.vm_checkpoint}})).instance;cc.compiler_close();
  assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),instance.exports.cut);
  assert.equal(vm.vm_source_publish(source.length,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
await start(Buffer.from([0x6c]),true);
assert.equal(vm.vm_io(port,0x3fa,0x101,1n),0n);assert.equal(vm.vm_io(port,0x3fc,0x101,16n),0n);
assert.equal(vm.vm_io(port,0x3f8,0x101,65n),0n);assert.equal(vm.vm_io(port,0x3f8,0x101,66n),0n);
assert.equal(vm.vm_run(port,9n,1),2n);assert.equal(v.getBigUint64(cpu+56,true),0x12340100n);assert.equal(v.getBigUint64(cpu+1128,true),42n);
v.setUint32(dir+6*32+16,1,true);assert.equal(vm.vm_run(port,9n,1),1n);assert.equal(vm.vm_source_retired(),1n);assert.equal(a[payload(6)+256],65);
assert.equal(vm.vm_io(port,0x3f8,1,0n),0n);assert.equal(v.getBigUint64(port+8,true),66n,'second FIFO byte remains: no repeated first read');
assert.equal(vm.vm_checkpoint(port,0,0n,0n),6n,'checkpoint outside a bound call refused');
await start(Buffer.from([0x6e]),false);a[payload(6)+256]=67;
assert.equal(vm.vm_run(port,9n,1),26n);const ticket=v.getBigUint64(port+32,true);assert.equal(v.getBigUint64(port+8,true),67n);
a[payload(6)+256]=68; // Async source mutation must not replace the already-read output byte.
assert.equal(vm.vm_console_commit(port,9n,ticket,68),-1);assert.equal(vm.vm_console_commit(port,9n,ticket,67),1);
assert.equal(vm.vm_run(port,9n,1),1n);assert.equal(vm.vm_source_retired(),1n);assert.equal(v.getBigUint64(cpu+48,true),0x12340101n);
await start(Buffer.from([0xf3,0x6c]),false);put(cpu+8,513);put(cpu+16,0x3ff);
assert.equal(vm.vm_io(port,0x3ff,0x101,91n),0n);
assert.equal(vm.vm_run(port,9n,1),10n);assert.equal(v.getBigUint64(cpu+8,true),257n);assert.equal(v.getBigUint64(cpu+1128,true),42n);
assert.equal(vm.vm_run(port,9n,1),10n);assert.equal(v.getBigUint64(cpu+8,true),1n);
assert.equal(vm.vm_run(port,9n,1),1n);assert.equal(v.getBigUint64(cpu+8,true),0n);assert.equal(v.getBigUint64(cpu+1128,true),43n);
assert(a.subarray(payload(6)+256,payload(6)+256+513).every(byte=>byte===91));
vm.vm_close();console.log(JSON.stringify({format:'string-io-c-boundary-v1',status:'pass',inputReadOnce:1,outputLatchedByte:1,
  quantumResumes:2,oracle:'C UART FIFO/resource/console models, not physical I/O silicon or production page supply',linuxBoot:'not-tested'},null,2));
