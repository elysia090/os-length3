// Paired cold compiler cost, not a Linux/browser runtime speed measurement.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
const [beforeFile,afterFile]=process.argv.slice(2);
if(!afterFile)throw new Error('BEFORE.wasm AFTER.wasm');
async function open(file){
  const memory=new WebAssembly.Memory({initial:16,maximum:32});
  const cc=(await WebAssembly.instantiate(await readFile(file),{machine:{memory}})).instance.exports;
  const bytes=new Uint8Array(memory.buffer),v=new DataView(memory.buffer),input=cc.compiler_arena_min();
  const options=input+8192,output=input+16384,report=output+65536,count=130;
  bytes.fill(0x90,input,input+4096);
  for(let i=0;i<count;++i){const at=input+64+i*16;bytes[at]=0xb8;v.setUint32(at+1,i*31337,true);bytes[at+5]=0xc3;
    v.setBigUint64(options+i*16,0x400040n+BigInt(i*16),true);v.setUint32(options+i*16+8,1,true);v.setUint32(options+i*16+12,65536,true);}
  assert.equal(cc.compiler_open_pages(input,1,0x400000n,9n),0);
  return {emit(){const start=performance.now();assert.equal(cc.compiler_emit_projection(options,count,output,65536,report),0);
    return performance.now()-start;},digest(){const n=Number(v.getBigUint64(report+40,true));
    return {bytes:n,sha256:createHash('sha256').update(bytes.subarray(output,output+n)).digest('hex')};},close(){cc.compiler_close();}};
}
const before=await open(beforeFile),after=await open(afterFile),a=[],b=[];
for(let i=0;i<20;++i){before.emit();after.emit();}
for(let i=0;i<101;++i){if(i%2){b.push(after.emit());a.push(before.emit());}else{a.push(before.emit());b.push(after.emit());}}
assert.deepEqual(before.digest(),after.digest(),'published bytes must stay identical');
const median=x=>x.sort((a,b)=>a-b)[Math.floor(x.length/2)],oldMs=median(a),newMs=median(b);
console.log(JSON.stringify({format:'paired-virtual-body-compile-bench-v1',samples:101,warmup:20,
  sourceExports:130,cap:65536,output:before.digest(),beforeMedianMs:oldMs,afterMedianMs:newMs,
  ratio:newMs/oldMs,scope:'Node C-Wasm cold compilation only; not native/browser/Linux execution speed'}));
before.close();after.close();
