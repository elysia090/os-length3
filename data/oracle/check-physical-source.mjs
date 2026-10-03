// Actual C-Wasm boot-source gate; not firmware implementation or Linux boot.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,fixtureDirectory]=process.argv.slice(2);
if (!fixtureDirectory) throw new Error('usage: check-physical-source.mjs VM.WASM BOOT-FIXTURE-DIRECTORY');
const memory=new WebAssembly.Memory({initial:8});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const bytes=Buffer.from(memory.buffer), view=new DataView(memory.buffer);
const input=vm.vm_arena_min(), directory=input+8192, branches=directory+512;
const base=(input+16384+4095)&~4095, port=base+2048, request=base+2176;
const header=await readFile(path.join(fixtureDirectory,'boot.header'));
const command=await readFile(path.join(fixtureDirectory,'boot.command'));
const meta=JSON.parse(await readFile(path.join(fixtureDirectory,'boot.json')));
bytes.set(header,input); bytes.set(command,input+4096);
assert.equal(vm.vm_boot_prepare(input,header.length,BigInt(meta.imageBytes),BigInt(meta.initramfsBytes),
  BigInt(meta.ramBytes),input+4096,command.length),0);
const put=(at,value)=>view.setBigUint64(at,BigInt(value),true);
const address=0xffffffffff200000n, shifts=[39n,30n,21n,12n], ptes=[];
for (let level=0;level<4;++level) {
  const row=directory+level*32, offset=(level+2)*4096;
  put(row,(level+1)*4096); view.setUint32(row+8,offset,true);
  view.setUint32(row+12,3,true); view.setUint32(row+16,1,true);
  const pte=base+offset+Number((address>>shifts[level])&511n)*8;
  ptes.push(pte); put(pte,BigInt((level+2)*4096)|0x27n);
}
put(port,9); put(base+384,0xffffffff812357cbn); put(base+392,0x10002);
put(base+400,0x80010001); put(base+408,0x1000); put(base+416,0xa0); put(base+424,0xd00);
put(base+488,8); put(base+1128,42);
assert.equal(vm.vm_open(base,memory.buffer.byteLength-base,4096,directory,4,8,branches,9n),0);
assert.equal(vm.vm_bind_state(base),0);
let count=0;
for (const physical of [0xa0000n,0xbf000n,BigInt(meta.ramBytes)])
for (const direction of [1,2,3]) for (const width of [1,2,4,8]) {
  put(ptes[3],physical|0x67n); // already-accessed/dirty table: isolate supply effects
  bytes.fill(0xa5,request,request+48);
  const cpu=Buffer.from(bytes.subarray(base,base+1256));
  const result=direction===3 ? vm.vm_reserve(port,address,width,3)
    : vm.vm_access(port,address,width,direction,0x1122334455667788n);
  assert.equal(result,2n); assert(bytes.subarray(base,base+1256).equals(cpu));
  assert.equal(view.getBigUint64(port+32,true),physical);
  assert.equal(view.getUint32(port+40,true),width); assert.equal(view.getUint32(port+44,true),direction|16);
  const before=Buffer.from(bytes);
  assert.equal(vm.vm_page_prepare(port,request),-4);
  assert(bytes.equals(before),'unmapped source must not publish bytes, page, ticket or CPU/fault');
  assert.equal(vm.vm_page_count(),4); assert.equal(vm.vm_page_commit(port,1n),-1);
  ++count;
}
console.log(`Actual C-Wasm physical-source gate: ${count} read/write/RMW/width cases green; no invented RAM/firmware/#PF; NOT Linux boot`);
