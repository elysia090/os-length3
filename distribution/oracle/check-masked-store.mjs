// Direct generated transfers through the real C MMU and sparse write owner.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [provider,directory]=process.argv.slice(2);
if(!directory)throw new Error('VM.wasm EMITTED-DIRECTORY');
const memory=new WebAssembly.Memory({initial:16}),vm=(await WebAssembly.instantiate(await readFile(provider),{machine:{memory}})).instance.exports;
const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),dir=vm.vm_arena_min(),cpu=dir+4096,segments=cpu+1408,port=cpu+2048;
const put=(at,value)=>v.setBigUint64(at,BigInt(value),true),entry=0x400000n,payload=cpu+24576;
let comparisons=0,faults=0;
for(let wide=0;wide<2;wide++)for(let address32=0;address32<2;address32++){
  const module=new WebAssembly.Module(await readFile(path.join(directory,`masked-${wide}-${address32}.wasm`)));
  const cut=new WebAssembly.Instance(module,{machine:{memory,write_begin:vm.vm_write_begin,write_word:vm.vm_write_word,write_end:vm.vm_write_end,floating_wait:vm.vm_floating_wait}}).exports.cut;
  vm.vm_close();data.fill(0,dir);
  [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000].forEach((address,i)=>{put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
  put(cpu+8192,0x2067);put(cpu+12288,0x3067);put(cpu+16384+16,0x4067);put(cpu+20480,0x8067);put(cpu+20488,0x9067);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa0fb,true);put(port,9);
  assert.equal(vm.vm_open(cpu,data.length-cpu,4096,dir,6,6,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
  const bytes=wide?16:8,count=1<<bytes;
  for(let mask=0;mask<count;mask++){
    data.fill(0,cpu,cpu+1256);data.fill(0xa5,payload,payload+8192);
    const offset=mask%3===0?4096-7:mask%3===1?9:4080;
    put(cpu+56,0x400000n+BigInt(offset)+(address32?1n<<32n:0n));put(cpu+384,entry);put(cpu+392,0x10202);put(cpu+400,0x80010031);
    put(cpu+408,0x1000);put(cpu+416,0x220);put(cpu+424,0xd00);put(cpu+488,19);put(cpu+1128,42);
    v.setUint16(cpu+1232,0x37f,true);v.setUint16(cpu+1234,0x2800,true);v.setUint16(cpu+1236,0xffff,true);
    const source=wide?cpu+128:cpu+1152,select=wide?cpu+144:cpu+1160;
    for(let i=0;i<bytes;i++){data[source+i]=(i*37+mask)&255;data[select+i]=((mask>>i)&1)*128|((i*7+mask)&127);}
    const before=Buffer.from(data.subarray(cpu,cpu+1256));
    assert.equal(cut(cpu,port,entry,0),1n);
    for(let i=0;i<8192;i++){const n=i-offset,wanted=n>=0&&n<bytes&&(mask>>n&1)?before[source-cpu+n]:0xa5;
      if(data[payload+i]!==wanted)assert.fail(`${wide}/${address32}/${mask}: byte${i}`);}
    assert.equal(v.getBigUint64(cpu+1128,true),43n);assert.equal(v.getBigUint64(cpu+392,true),0x202n);
    assert.equal(v.getBigUint64(cpu+384,true),entry+BigInt(wide?address32?5:4:address32?4:3));
    // The architectural scalar/vector inputs and all unrelated state bytes
    // remain exact. MMX tag/TOP publication has its existing separate owner.
    const after=Buffer.from(data.subarray(cpu,cpu+1256));before.copy(after,384,384,392);before.copy(after,392,392,400);before.copy(after,1128,1128,1136);
    if(!wide)before.copy(after,1234,1234,1238);
    assert(after.equals(before),'unrelated CPU state changed');++comparisons;
  }
  // Entire declared extent is checked before the first store, including a
  // later page fault and a zero mask under the declared CPU representative.
  for(const mask of [0,1,0xffff]){
    data.fill(0,cpu,cpu+1256);data.fill(0xa5,payload,payload+8192);put(cpu+56,0x400fffn);put(cpu+384,entry);put(cpu+392,0x202);
    put(cpu+400,0x80010031);put(cpu+408,0x1000);put(cpu+416,0x220);put(cpu+424,0xd00);put(cpu+488,19);v.setUint16(cpu+1232,0x37f,true);
    const select=wide?cpu+144:cpu+1160;for(let i=0;i<bytes;i++)data[select+i]=(mask>>i&1)*128;
    put(cpu+20488,0);const before=Buffer.from(data.subarray(cpu,cpu+1256));
    assert.equal(cut(cpu,port,entry,0),115n);assert(data.subarray(cpu,cpu+1256).equals(before));
    assert(data.subarray(payload,payload+8192).every(b=>b===0xa5));put(cpu+20488,0x9067);++faults;
  }
}
vm.vm_close();console.log(JSON.stringify({status:'pass',comparisons,faults,scope:'C MMU sparse-store and CPU-state model; not physical-CPU exception or Linux proof'}));
