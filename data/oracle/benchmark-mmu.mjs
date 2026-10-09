// Equal C-MMU/access workloads. This measures neither Linux nor host RSS.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const files=process.argv.slice(2);if(files.length!==2)throw new Error('BASELINE-VM.WASM CURRENT-VM.WASM');
const prepared=[];
for(const file of files){const memory=new WebAssembly.Memory({initial:16});
  const vm=(await WebAssembly.instantiate(await readFile(file),{machine:{memory}})).instance.exports;
  const v=new DataView(memory.buffer),a=new Uint8Array(memory.buffer),dir=vm.vm_arena_min(),cpu=dir+4096,
    port=cpu+2048,segments=cpu+1408;const put=(at,x)=>v.setBigUint64(at,BigInt(x),true);
  for(const [i,address]of [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000].entries()){
    put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);
    v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);}
  put(cpu+8192,0x2067);put(cpu+12288,0x3067);put(cpu+16384+16,0x4067);
  put(cpu+20480,0x8067);put(cpu+20488,0x9067);
  put(cpu+400,0x80010001);put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0xd00);
  put(port,9);v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
  assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,6,6,dir+2048,9n),0);
  assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
  prepared.push({file,vm,port,v,a,cpu});
}
const runs=prepared.map(p=>({file:p.file,read8:[],write8:[],cross8:[]}));
for(let round=0;round<7;++round)for(const index of round&1?[1,0]:[0,1]){
  const {vm,port}=prepared[index];
  for(const [name,address,access]of [['read8',0x400100n,1],['write8',0x400100n,2],['cross8',0x400ffdn,1]]){
    assert.equal(vm.vm_access(port,address,8,access,0x123456789abcdef0n),0n);
    const start=performance.now();let result=0n;
    for(let n=0;n<250000;++n)result|=vm.vm_access(port,address,8,access,0x123456789abcdef0n);
    assert.equal(result,0n);runs[index][name].push(performance.now()-start);
  }
}
const median=xs=>[...xs].sort((a,b)=>a-b)[xs.length>>1];
const medians=runs.map(row=>({file:row.file,...Object.fromEntries(['read8','write8','cross8'].map(k=>[k,median(row[k])]))}));
console.log(JSON.stringify({format:'c-mmu-equal-work-benchmark-v1',operationsPerSample:250000,rounds:7,mediansMs:medians,
  ratios:Object.fromEntries(['read8','write8','cross8'].map(k=>[k,medians[1][k]/medians[0][k]])),
  scope:'actual C MMU, page proof/read/write/cross-page; JS import-call cost included; not Linux cold-ready'},null,2));
