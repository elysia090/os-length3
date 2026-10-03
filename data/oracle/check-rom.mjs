// Actual C-Wasm ROM admission/MMU. No JavaScript guest bus or payload callback.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,fixtures]=process.argv.slice(2);
if (!fixtures) throw new Error('usage: check-rom.mjs VM.WASM BOOT-FIXTURE-DIRECTORY');
const memory=new WebAssembly.Memory({initial:8});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const bytes=Buffer.from(memory.buffer),view=new DataView(memory.buffer), put=(at,value)=>view.setBigUint64(at,BigInt(value),true);
const input=vm.vm_arena_min(), directory=input+8192, branches=directory+1024;
const base=(input+16384+4095)&~4095,port=base+2048,request=base+2176;
const header=await readFile(path.join(fixtures,'boot.header')),command=await readFile(path.join(fixtures,'boot.command'));
const meta=JSON.parse(await readFile(path.join(fixtures,'boot.json')));
bytes.set(header,input); bytes.set(command,input+4096);
assert.equal(vm.vm_boot_prepare(input,header.length,BigInt(meta.imageBytes),BigInt(meta.initramfsBytes),BigInt(meta.ramBytes),input+4096,command.length),0);
assert.equal(vm.vm_boot_initial_segments(base+1408),0);
const address=0xffffffffff200000n,shifts=[39n,30n,21n,12n],ptes=[];
for(let level=0;level<4;++level) {
  const row=directory+level*32,offset=(level+2)*4096;
  put(row,(level+1)*4096); view.setUint32(row+8,offset,true); view.setUint32(row+12,3,true); view.setUint32(row+16,1,true);
  const pte=base+offset+Number((address>>shifts[level])&511n)*8;
  ptes.push(pte); put(pte,BigInt((level+2)*4096)|0x27n);
}
put(port,9); put(base+384,0xffffffff812357cbn); put(base+392,0x10002);
put(base+400,0x80010001); put(base+408,0x1000); put(base+416,0xa0); put(base+424,0xd00); put(base+488,8); put(base+1128,42);
assert.equal(vm.vm_open(base,bytes.length-base,4096,directory,4,8,branches,9n),0);
assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(base+1408),0);
function supply(physical,virtual=address) {
  assert.equal(vm.vm_access(port,virtual,1,1,0n),2n);
  assert.equal(vm.vm_page_prepare(port,request),0);
  assert.equal(view.getBigUint64(request+8,true),physical);
  const target=view.getUint32(request+24,true), kind=view.getUint32(request+32,true),ticket=view.getBigUint64(request+40,true);
  assert.equal(kind,physical<0x100000n?4:0); assert.equal(view.getUint32(request+28,true),0);
  assert.equal(vm.vm_page_prepare(port,request),0); assert.equal(view.getBigUint64(request+40,true),ticket);
  assert.equal(vm.vm_page_commit(port,ticket+1n),-1); assert.equal(vm.vm_page_commit(port,ticket),0); assert.equal(vm.vm_page_commit(port,ticket),-1);
  const row=directory+(vm.vm_page_count()-1)*32;
  assert.equal(view.getUint32(row+16,true),kind===4?4:1);
  const expected=kind===4?255:0;
  assert(bytes.subarray(target,target+4096).every(byte=>byte===expected));
  return target;
}
const cpu=Buffer.from(bytes.subarray(base,base+1256)); let cases=0;
for(const physical of [0xc0000n,0xf0000n,0xff000n]) {
  put(ptes[3],physical|0x67n); const target=supply(physical);
  for(const at of [0,1,7,4088]) for(const width of [1,2,4,8]) for(const direction of [1,2,3]) {
    const result=direction===3?vm.vm_reserve(port,address+BigInt(at),width,3):vm.vm_access(port,address+BigInt(at),width,direction,0x1122334455667788n);
    assert.equal(result,0n);
    if(direction!==2) assert.equal(view.getBigUint64(port+8,true),(1n<<BigInt(width*8))-1n);
    if(direction===3) { assert.equal(vm.vm_commit(port,0x1122334455667788n),0n); assert.equal(vm.vm_commit(port,0n),6n); }
    assert(bytes.subarray(target,target+4096).every(byte=>byte===255)); assert(bytes.subarray(base,base+1256).equals(cpu)); ++cases;
  }
}
put(ptes[3]+8,0x100067); const ram=supply(0x100000n,address+4096n);
for(const reverse of [false,true]) for(const width of [2,4,8]) for(let head=1;head<width;++head) for(const reserve of [false,true]) {
  put(ptes[3],(reverse?0x100000n:0xff000n)|0x67n); put(ptes[3]+8,(reverse?0xff000n:0x100000n)|0x67n);
  assert.equal(vm.vm_access(port,address+(reverse?0n:4096n),8,2,0n),0n); // only reset RAM through C
  const value=0x1122334455667788n,start=address+4096n-BigInt(head);
  assert.equal(reserve?vm.vm_reserve(port,start,width,3):vm.vm_access(port,start,width,2,value),0n);
  if(reserve) assert.equal(vm.vm_commit(port,value),0n);
  for(let i=0;i<width;++i) {
    assert.equal(vm.vm_access(port,start+BigInt(i),1,1,0n),0n);
    const inRom=reverse?i>=head:i<head;
    assert.equal(view.getBigUint64(port+8,true),inRom?255n:(value>>BigInt(i*8))&255n);
  }
  assert(bytes.subarray(base,base+1256).equals(cpu)); ++cases;
}
put(ptes[3],0xf0065); assert.equal(vm.vm_access(port,address,4,2,0n),115n);
assert.equal(view.getUint32(port+24,true),14); assert.equal(view.getUint32(port+28,true),3);
put(ptes[3],0x80000000000f0067n); assert.equal(vm.vm_code(port,address,request),115n);
assert.equal(view.getUint32(port+28,true),17);
assert.equal(vm.vm_page_count(),8); assert(ram>base);
console.log(`Actual C-Wasm ROM: ${cases} immutable and mixed RAM/ROM read/write/RMW cases; precise RW/NX paging, typed supply retry/replay; NOT Linux boot`);
