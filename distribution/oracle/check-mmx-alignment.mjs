// Actual C compiler/MMU model: FS base is applied before MOVNTQ alignment.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile]=process.argv.slice(2);
const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),cold=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,dir=vm.vm_arena_min(),cpu=dir+4096,segments=cpu+1408,port=cpu+2048;
const put=(at,x)=>v.setBigUint64(at,BigInt(x),true),entry=0x400000n,source=Buffer.from([0x64,0x0f,0xe7,0x07]);
cold.fill(0x90,ci,ci+4096);cold.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);
assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);
const cut=(await WebAssembly.instantiate(cold.subarray(co,co+Number(cv.getBigUint64(cr+40,true))),
  {machine:{memory,access:vm.vm_access,floating_wait:vm.vm_floating_wait}})).instance.exports.cut;
for(const aligned of [true,false]){
  vm.vm_close();data.fill(0,dir);
  [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000].forEach((address,i)=>{
    put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
  put(cpu+8192,0x2067);put(cpu+12288,0x3067);put(cpu+16384+16,0x4067);put(cpu+20480,0x8067);put(cpu+20488,0x9067);
  put(cpu+56,aligned?0x40100f:0x401010);put(cpu+384,entry);put(cpu+392,0x10202);put(cpu+400,0x80010031);
  put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0xd00);put(cpu+488,19);put(cpu+600,0x400);put(cpu+1128,42);
  put(cpu+1152,0x1122334455667788n);v.setUint16(cpu+1216,0x3fff,true);v.setUint16(cpu+1232,0x37f,true);v.setUint16(cpu+1236,0xffff,true);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa0fb,true);put(segments+72,1);v.setUint32(segments+84,0x10000,true);put(port,9);
  assert.equal(vm.vm_open(cpu,data.length-cpu,4096,dir,6,6,dir+1024,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
  const before=Buffer.from(data.subarray(cpu,cpu+1256)),payload=Buffer.from(data.subarray(cpu+28672,cpu+32768));
  const result=cut(cpu,port,entry,cv.getUint32(cr+76,true));
  if(aligned){assert.equal(result,1n);assert.equal(v.getBigUint64(cpu+28672+16,true),0x1122334455667788n);assert.equal(v.getBigUint64(cpu+1128,true),43n);}
  else{assert.equal(result,107n);assert.equal(v.getUint32(port+24,true),13);assert.equal(v.getUint32(port+28,true),0);
    assert(data.subarray(cpu,cpu+1256).equals(before));assert(data.subarray(cpu+28672,cpu+32768).equals(payload));}
}
vm.vm_close();cc.compiler_close();console.log(JSON.stringify({status:'pass',models:2,scope:'C MMU FS-before-alignment, not hardware observation/Linux boot'}));
