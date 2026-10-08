// Independent system frames -> ordinary generated Wasm -> C event owner.
// Only fixture preparation/comparison is JavaScript, not guest execution.
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile,traceFile]=process.argv.slice(2);
if(!traceFile)throw new Error('VM.WASM COMPILER.WASM WHPX-EVENTS');
const rows=(await readFile(traceFile,'utf8')).trim().split(/\r?\n/).map(line=>line.trim().split(/\s+/).map(x=>BigInt('0x'+x)));
assert.equal(rows.length,1152);
const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16}),
  vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports,
  cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports,
  a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),
  dir=vm.vm_arena_min(),cpu=dir+4096,port=cpu+2048,segments=cpu+1408,payload=i=>cpu+(i+2)*4096,
  ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,put=(at,x)=>v.setBigUint64(at,BigInt(x),true),modules=new Map();
let comparisons=0,software=0,waitSuccess=0,nm=0,mf=0;
for(const [rank,r]of rows.entries()){
  assert.equal(r.length,28);assert.equal(r[0],BigInt(rank));const wait=Boolean(r[1]),vector=Number(r[11]),form=Number(r[3]),
    prefix=[0,0x66,0x67,0x48,0x64,0x65,0xf2,0xf3][form],source=Buffer.from(wait?[...(form?[prefix]:[]),0x9b]:[0xcd,Number(r[2])]);
  assert.equal(r[9],BigInt(source.length));assert.equal(r[26],r[5]);assert.equal(r[27],r[6]);
  const key=source.toString('hex');let made=modules.get(key);
  if(!made){c.fill(0x90,ci,ci+4096);c.set(source,ci+Number(r[8]&4095n));
    assert.equal(cc.compiler_open_pages(ci,1,r[8]&~4095n,9n),0);assert.equal(cc.compiler_emit(r[8],1,co,65536,cr),0);
    const module=await WebAssembly.compile(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))));
    made={cut:(await WebAssembly.instantiate(module,{machine:{memory,software_interrupt:vm.vm_software_interrupt,floating_wait:vm.vm_floating_wait}})).exports.cut,
      binding:cv.getUint32(cr+76,true)};modules.set(key,made);cc.compiler_close();}
  vm.vm_close();a.fill(0,dir);
  const physical=[0x1000,0x2000,0x3000,0x4000,0x5000,Number((r[10]&~4095n)-4096n),Number(r[10]&~4095n)];
  physical.forEach((address,i)=>{put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
  put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2),0xe3);
  put(payload(3)+8,0x00af9b000000ffffn);put(payload(3)+16,0x00cf93000000ffffn);
  if(r[18]){put(payload(4)+vector*16,(r[25]&0xffffn)|8n<<16n|BigInt((rank&1)?0x8f:0x8e)<<40n|((r[25]>>16n)&0xffffn)<<48n);
    v.setUint32(payload(4)+vector*16+8,Number(r[25]>>32n),true);}
  for(let reg=0;reg<16;++reg)put(cpu+reg*8,0xabcdef0123450000n+BigInt(reg));
  put(cpu+32,r[10]);put(cpu+384,r[8]);put(cpu+392,r[7]);put(cpu+400,r[4]);put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0x500);
  put(cpu+448,0x4000);put(cpu+456,23);put(cpu+464,0x5000);put(cpu+472,4095);put(cpu+488,8);put(cpu+496,16);
  put(cpu+592,r[19]);put(cpu+600,r[21]);put(cpu+1128,42);put(port,9);
  v.setUint16(cpu+1232,Number(r[5]),true);v.setUint16(cpu+1234,Number(r[6]),true);v.setUint16(cpu+1236,0xffff,true);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);v.setUint32(segments+52,0xc093,true);
  assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,7,7,dir+1024,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
  const before=Buffer.from(a.subarray(cpu,cpu+1256)),expected=Buffer.from(before),result=made.cut(cpu,port,r[8],made.binding);
  if(wait&&r[18]){assert.equal(result,BigInt(vector)*8n+3n);assert(a.subarray(cpu,cpu+1256).equals(before));assert.equal(vm.vm_fault(port),0n);
    vector===7?++nm:++mf;
  }else{assert.equal(result,1n);wait?++waitSuccess:++software;expected.writeBigUInt64LE(43n,1128);}
  if(r[18]){
    expected.writeBigUInt64LE(r[18],32);expected.writeBigUInt64LE(r[25],384);expected.writeBigUInt64LE(r[17],392);
    expected.writeBigUInt64LE(r[20],592);expected.writeBigUInt64LE(r[22],600);
    const image=Buffer.alloc(8192);[r[12],r[13],r[14],r[15],r[16]].forEach((word,i)=>image.writeBigUInt64LE(word,Number(r[18]-BigInt(physical[5]))+i*8));
    assert(a.subarray(payload(5),payload(6)+4096).equals(image),`independent complete frame ${rank}`);
  }else{expected.writeBigUInt64LE(r[8]+r[9],384);expected.writeBigUInt64LE(r[7]&~0x10000n,392);}
  assert(a.subarray(cpu,cpu+1256).equals(expected),`state model with independent frame/debug/FPU fields ${rank}`);++comparisons;
}
vm.vm_close();console.log(JSON.stringify({status:'pass',comparisons,software,waitSuccess,nm,mf,modules:modules.size,
  oracle:'Independent WHPX INT vectors/FWAIT MP/TS/EM and pending error frames; other GPR invariance architectural, not bare-metal proof',linuxBoot:'not-tested'}));
