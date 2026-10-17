// C interrupt/exception model around actual compiled x87 entries. No opcode
// decoding or guest exception delivery in this test supervisor.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile]=process.argv.slice(2);
const memory=new WebAssembly.Memory({initial:16}),vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
// Private construction reservation; the guest C-MMU population stays16 pages.
// Current frontend data/stack requires17 pages before its bounded output arena.
const cm=new WebAssembly.Memory({initial:32}),cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,dir=vm.vm_arena_min(),cpu=dir+4096,rows=dir+512,
  port=cpu+2048,segments=cpu+1408,codeView=port+64,payload=i=>cpu+(i+2)*4096;
const put=(at,x)=>v.setBigUint64(at,BigInt(x),true),get=at=>v.getBigUint64(at,true),table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));
const imports={memory,floating_wait:vm.vm_floating_wait,access:vm.vm_access,reserve:vm.vm_reserve,commit:vm.vm_commit,
  io:vm.vm_io,iret:vm.vm_iret};
const handler=[0x50,0xdb,0xe2,0xb0,0x20,0xe6,0xa0,0xe6,0x20,0x58,0x48,0xcf];
const cache=new Map();let faults=0,masked=0,legacy=0;
function reset(source,{cr0=0x80010031n,sw=0x1a00,cw=0x37f}={}){
  vm.vm_close();a.fill(0,dir);
  [0x1000,0x2000,0x3000,0x4000,0x5000,0x8000,0x9000,0xa000,0xb000].forEach((address,i)=>{
    put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
  put(payload(0),0x2027);put(payload(1),0x3027);put(payload(2),0xe7);
  put(payload(3)+8,0x00af9b000000ffffn);put(payload(3)+16,0x00cf93000000ffffn);
  for(let r=0;r<16;++r)put(cpu+r*8,0x123456789abc0000n+BigInt(r));
  put(cpu+32,0xaf00);put(cpu+384,0x9000);put(cpu+392,0x10202);put(cpu+400,cr0);put(cpu+408,0x1000);
  put(cpu+416,32);put(cpu+424,0x500);put(cpu+448,0x4000);put(cpu+456,23);put(cpu+464,0x5000);
  put(cpu+472,4095);put(cpu+488,8);put(cpu+496,16);put(cpu+600,0x400);put(cpu+1128,123);
  for(let r=0;r<8;++r){put(cpu+1152+r*8,0x8000000000000000n);v.setUint16(cpu+1216+r*2,0x3fff,true);}
  v.setUint16(cpu+1232,cw,true);v.setUint16(cpu+1234,sw,true);v.setUint16(cpu+1236,0,true);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);v.setUint32(segments+52,0xc093,true);put(port,9);
  a.set(source,payload(6));a.set(handler,payload(5));
  assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,9,9,dir+2048,9n),0);
  assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
}
async function bind(entry,source){
  assert.equal(get(cpu+384),entry);const key=`${entry}:${source.join(',')}`;let made=cache.get(key);
  if(!made){const page=entry&~4095n;c.fill(0x90,ci,ci+4096);c.set(source,ci+Number(entry-page));
    assert.equal(cc.compiler_open_pages(ci,1,page,9n),0);assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);
    const n=Number(cv.getBigUint64(cr+40,true)),instance=(await WebAssembly.instantiate(c.subarray(co,co+n),{machine:imports})).instance;
    made={fn:instance.exports.cut,span:Number(cv.getBigUint64(cr+32,true)),binding:cv.getUint32(cr+76,true)};cache.set(key,made);}
  const queried=vm.vm_source_query(port,entry,1,codeView,rows);
  if(queried===1n){table.set(v.getUint32(rows+16,true),made.fn);assert.equal(vm.vm_source_publish(made.span,1,made.binding,rows),0);}
  else assert.equal(queried,0n,'resume uses the exact still-admitted C source row');
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
for(const prefix of [[],[0x66],[0x67],[0x48],[0xf2],[0xf3]])for(const pop of [0,1])for(const ordered of [0,1])for(const index of [0,1,7]){
  const source=[...prefix,pop?0xdf:0xdb,(ordered?0xf0:0xe8)+index];
  for(const [mask,vector] of [[4n,7],[8n,7],[12n,7],[0n,16]]){
    reset(source,{cr0:0x80010031n|mask,cw:0x37e,sw:0x9a81});await bind(0x9000n,source);
    const before=Buffer.from(a.subarray(cpu,cpu+1256)),ram=Buffer.from(a.subarray(payload(3),payload(8)+4096));
    assert.equal(vm.vm_run(port,9n,1),BigInt(vector)*8n+3n);assert.equal(v.getUint32(port+24,true),vector);
    assert.equal(get(port+16),0x9000n);assert(a.subarray(cpu,cpu+1256).equals(before));assert(a.subarray(payload(3),payload(8)+4096).equals(ram));
    assert.equal(vm.vm_completed(),0);assert.equal(vm.vm_source_retired(),0n);++faults;
  }
  reset(source,{sw:0x1a01});await bind(0x9000n,source);assert.equal(vm.vm_run(port,9n,1),1n);
  assert.equal(v.getUint16(cpu+1234,true)&1,1);++masked;
}
// The legacy waiting entry must be interruptible, but must not retire or
// fabricate #MF. Actual C PIC -> IDT/GDT/stack entry -> compiled guest handler
// -> no-wait clear -> guest EOI -> IRET -> retry is the completion path.
const source=[0xdf,0xe8];reset(source,{cr0:0x80010011n,cw:0x37e,sw:0x9a81});
const io=(p,write,value=0)=>assert.equal(vm.vm_io(port,p,1|(write?0x100:0),BigInt(value)),0n);
for(const [p,x]of [[0x20,0x11],[0xa0,0x11],[0x21,32],[0xa1,40],[0x21,4],[0xa1,2],[0x21,1],[0xa1,1],[0x21,0xfb],[0xa1,0xdf]])io(p,1,x);
put(payload(4)+45*16,0x8000n|(8n<<16n)|(0x8en<<40n));await bind(0x9000n,source);
const before=Buffer.from(a.subarray(cpu,cpu+1256));assert.equal(vm.vm_run(port,9n,1),34n);
assert(a.subarray(cpu,cpu+1256).equals(before));assert.equal(vm.vm_completed(),0);assert.equal(vm.vm_source_retired(),0n);
// F0h drops the board wire, not the already edge-latched PIC request or
// numerical error. Stale event admission must not modify the waiting state.
put(port,8);assert.equal(vm.vm_floating_wait(port),5n);put(port,9);
io(0xf0,1,0);assert(a.subarray(cpu,cpu+1256).equals(before));
assert.equal(vm.vm_boundary(port,9n),1n);assert.equal(get(cpu+384),0x8000n);assert.equal(get(cpu+1128),123n);
for(const [offset,code]of [[0,[0x50]],[1,[0xdb,0xe2]],[3,[0xb0,0x20]],[5,[0xe6,0xa0]],[7,[0xe6,0x20]],[9,[0x58]],[10,[0x48,0xcf]]]){
  await bind(0x8000n+BigInt(offset),code);const result=vm.vm_run(port,9n,1);
  // A successful IRET retires, then revokes the old execution context. Its
  // STALE result requires fresh source admission, not architectural rollback.
  assert.equal(result,offset===10?5n:1n);assert.equal(vm.vm_source_retired(),1n);
}
assert.equal(get(cpu+384),0x9000n);assert.equal(v.getUint16(cpu+1234,true),0x1a00);assert.equal(get(cpu),before.readBigUInt64LE(0));
await bind(0x9000n,source);assert.equal(vm.vm_run(port,9n,1),1n);assert.equal(get(cpu+384),0x9002n);
assert.equal(get(cpu+1128),131n);assert.equal(v.getUint16(cpu+1234,true),0x2200);++legacy;
cc.compiler_close();vm.vm_close();console.log(JSON.stringify({format:'compiled-x87-exception-boundaries-v1',status:'pass',faults,masked,legacy,
  oracle:'C/MMU/PIC/IDT/guest-handler model, not a hardware legacy FERR certification',linuxBoot:'not-tested'},null,2));
