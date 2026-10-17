// C-Wasm MMU microbenchmark, not Linux/browser boot or whole-program speed.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [beforeFile,afterFile,...extra]=process.argv.slice(2);
if(!afterFile || extra.length)throw new Error('usage: benchmark-read-pair.mjs RECORD-BUFFER-VM.wasm DIRECT-PAIR-VM.wasm');
async function prepare(file) {
  const bytes=await readFile(file),memory=new WebAssembly.Memory({initial:8});
  const vm=(await WebAssembly.instantiate(bytes,{machine:{memory}})).instance.exports;
  const directory=vm.vm_arena_min(),base=directory+4096,port=base+2048;
  const data=new Uint8Array(memory.buffer),view=new DataView(memory.buffer);
  const put=(at,value)=>view.setBigUint64(at,BigInt(value),true),address=0x12340000n;
  for(let i=0;i<6;++i){const row=directory+i*32;put(row,(i+1)*4096);view.setUint32(row+8,(i+2)*4096,true);
    view.setUint32(row+12,3,true);view.setUint32(row+16,1,true);}
  const table=physical=>base+(Number(physical/4096n)+1)*4096;
  put(table(0x1000n),0x2067);put(table(0x2000n),0x3067);put(table(0x3000n)+145*8,0x4067);
  put(table(0x4000n)+Number(address>>12n&511n)*8,0x5067);
  put(table(0x4000n)+Number((address+4096n)>>12n&511n)*8,0x6067);
  put(base+400,0x80010011);put(base+408,0x1000);put(base+416,0x220);put(base+424,0xd00);
  put(base+432,19);put(port,9);
  for(let i=0;i<8192;++i)data[table(0x5000n)+i]=(i*37+19)&255;
  assert.equal(vm.vm_open(base,data.length-base,4096,directory,6,6,directory+256,9n),0);
  assert.equal(vm.vm_bind_state(base),0);
  const cpu=data.slice(base,base+1256);
  return {file,bytes:bytes.length,memory,vm,port,base,data,view,address,table,cpu};
}
const providers=await Promise.all([prepare(beforeFile),prepare(afterFile)]);
const iterations=100000,trials=8,results=[];
try {
  for(const offset of [512,4088,4095]) {
    const samples=[[],[]];
    for(const provider of providers) {
      const {vm,port,address,view,table,data}=provider;
      assert.equal(vm.vm_read_pair(port,address+BigInt(offset),16,1),0n);
      let low=0n,high=0n;
      for(let i=0;i<8;++i){low|=BigInt(data[table(0x5000n)+offset+i])<<BigInt(i*8);high|=BigInt(data[table(0x5000n)+offset+8+i])<<BigInt(i*8);}
      assert.equal(view.getBigUint64(port+8,true),low);assert.equal(view.getBigUint64(port+48,true),high);
      for(let i=0;i<20000;++i)vm.vm_read_pair(port,address+BigInt(offset),16,1);
    }
    for(let trial=0;trial<trials;++trial)for(const rank of trial&1?[1,0]:[0,1]) {
      const {vm,port,address}=providers[rank],operand=address+BigInt(offset),start=performance.now();
      let result=0n;for(let i=0;i<iterations;++i)result|=vm.vm_read_pair(port,operand,16,1);
      samples[rank].push(performance.now()-start);assert.equal(result,0n);
    }
    const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return (sorted[3]+sorted[4])/2;};
    const beforeMs=median(samples[0]),afterMs=median(samples[1]);
    results.push({offset,samplesMs:samples,beforeMs,afterMs,ratio:afterMs/beforeMs});
  }
  for(const {data,base,cpu}of providers)assert.deepEqual(data.subarray(base,base+1256),cpu);
  console.log(JSON.stringify({format:'c-mmu-read-pair-micro-v1',status:'pass',iterations,trials,
    providers:providers.map(({file,bytes})=>({file,bytes})),results,
    scope:'same complete C-MMU read, no record-buffer materialization; warm Node engine, not browser, Linux boot or end-to-end speed'},null,2));
} finally {for(const provider of providers)provider.vm.vm_close();}
