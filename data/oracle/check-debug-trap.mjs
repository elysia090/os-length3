// Independent reference frames -> common C compiler -> C exception owner.
// Fixture loading and result comparison only; no JS guest/event interpreter.
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile,traceFile,mode]=process.argv.slice(2);
if(!traceFile||(mode&&mode!=='--faults'))throw new Error('VM.WASM COMPILER.WASM WHPX-TRACE [--faults]');
const faultMode=mode==='--faults',rows=(await readFile(traceFile,'utf8')).trim().split(/\r?\n/)
  .map(line=>line.trim().split(/\s+/).map(x=>BigInt('0x'+x)));
assert.equal(rows.length,768);
const memory=new WebAssembly.Memory({initial:32}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports,
  cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),
  ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,dir=vm.vm_arena_min(),cpu=dir+4096,port=cpu+2048,segments=cpu+1408,
  payload=i=>cpu+(i+1)*4096,put=(at,x)=>v.setBigUint64(at,BigInt(x),true);
const prefixes=[0,0x66,0x67,0x48,0x64,0x65,0xf2,0xf3],modules=new Map();let comparisons=0,secondary=0;
for(let n=0;n<rows.length;++n){const r=rows[n];assert.equal(r.length,25);assert.equal(r[0],BigInt(n));assert.equal(r[22],0n,'primary trap must not be overwritten by observer reentry');
  const form=Number(r[1]),shadow=Number(r[2]),fault=faultMode?Number(((r[0]/8n)/3n>>1n)&3n):0;
  const source=Buffer.from(form?[prefixes[form],0xf1]:[0xf1]);assert.equal(r[9],BigInt(source.length));
  const key=r[8].toString(16);let made=modules.get(key);
  if(!made){c.fill(0x90,ci,ci+4096);c.set(source,ci+Number(r[8]&4095n));
    assert.equal(cc.compiler_open_pages(ci,1,r[8]&~4095n,9n),0);
    assert.equal(cc.compiler_emit(r[8],1,co,65536,cr),0,'F1 must use common compiler');
    const size=Number(cv.getBigUint64(cr+40,true)),instance=(await WebAssembly.instantiate(c.subarray(co,co+size),
      {machine:{memory,software_interrupt:vm.vm_software_interrupt}})).instance;
    made={cut:instance.exports.cut,binding:cv.getUint32(cr+76,true)};modules.set(key,made);cc.compiler_close();}
  vm.vm_close();a.fill(0,dir);
  const physical=[0x1000,0x2000,0x3000,0x4000,0x5000,0x107000,0x108000];
  physical.forEach((address,i)=>{put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+1)*4096,true);
    v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
  put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2),0xe3);
  put(payload(3)+8,0x00af9b000000ffffn);put(payload(3)+16,0x00cf93000000ffffn);
  function gate(vector,selector,type){put(payload(4)+vector*16,(r[23]&0xffffn)|BigInt(selector)<<16n|type<<40n|((r[23]>>16n)&0xffffn)<<48n);
    v.setUint32(payload(4)+vector*16+8,Number(r[23]>>32n),true);}
  for(const vector of [1,11,13])gate(vector,8,0x8en);
  gate(1,fault===3?24:8,r[3]);
  if(fault===1)a[payload(4)+21]&=0x7f;if(fault===2)a[payload(4)+21]=0x8d;
  let flags=r[5];if(shadow)flags&=~0x10000n;if(shadow===2)flags|=0x200n;
  for(let reg=0;reg<16;++reg)put(cpu+reg*8,0xabcdef0123450000n+BigInt(reg));
  put(cpu+32,r[4]);put(cpu+384,r[8]);put(cpu+392,flags);put(cpu+400,0x80010011);
  put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0x500);put(cpu+448,0x4000);put(cpu+456,23);
  put(cpu+464,0x5000);put(cpu+472,4095);put(cpu+488,8);put(cpu+496,16);put(cpu+592,r[6]);put(cpu+600,r[7]);put(cpu+1128,42);put(port,9);
  v.setUint32(segments,2,true);v.setUint32(segments+4,shadow,true);v.setUint32(segments+36,0xa09b,true);v.setUint32(segments+52,0xc093,true);
  a.fill(0x93,payload(5),payload(6)+4096);
  assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,7,7,dir+1024,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
  const before=Buffer.from(a.subarray(cpu,cpu+1256)),expected=Buffer.from(before),vector=Number(r[10]);
  let result=made.cut(cpu,port,r[8],made.binding);
  if(fault){assert.equal(result,BigInt(vector)*8n+3n);assert.equal(v.getUint32(port+28,true),Number(r[24]));
    const intermediate=Buffer.from(before);intermediate.writeBigUInt64LE(r[17],592);intermediate.writeBigUInt64LE(r[18],600);
    assert(a.subarray(cpu,cpu+1256).equals(intermediate),'failed delivery preserves source but not rolled-back debug effects');
    assert.equal(vm.vm_fault(port),0n);++secondary;
  }else assert.equal(result,1n,`normal row ${n}, vector/error ${v.getUint32(port+24,true)}/${v.getUint32(port+28,true)}, address ${v.getBigUint64(port+16,true).toString(16)}`);
  expected.writeBigUInt64LE(r[16],32);expected.writeBigUInt64LE(r[23],384);expected.writeBigUInt64LE(r[15],392);
  expected.writeBigUInt64LE(r[17],592);expected.writeBigUInt64LE(r[18],600);expected.writeBigUInt64LE(fault?42n:43n,1128);
  assert(a.subarray(cpu,cpu+1256).equals(expected),`full architectural model ${n}`);
  assert.equal(v.getUint32(segments+4,true),0);
  const words=fault?[r[24],r[11],8n,r[12],r[13],r[14]]:[r[11],8n,r[12],r[13],r[14]];
  const image=Buffer.alloc(8192,0x93);words.forEach((word,i)=>image.writeBigUInt64LE(word,Number(r[16]-0x107000n)+i*8));
  assert(a.subarray(payload(5),payload(6)+4096).equals(image),`complete independent frame/RAM model ${n}`);++comparisons;
}
vm.vm_close();console.log(JSON.stringify({format:'reference-debug-trap-c-v1',status:'pass',comparisons,secondaryDeliveries:secondary,
  modules:modules.size,oracle:'explicit WHPX system frames/DR status, not bare-metal certificate; other GPR invariance architectural',linuxBoot:'not-tested'},null,2));
