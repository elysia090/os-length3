// Same source/input/supervisor writes, actual emitted Wasm execution only.
// Preparation is excluded; this is not Linux/native-release performance.
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {performance} from 'node:perf_hooks';
const [beforeFile,afterFile]=process.argv.slice(2);if(!afterFile)throw new Error('BASELINE-COMPILER.WASM CURRENT-COMPILER.WASM');
async function prepare(file){const cm=new WebAssembly.Memory({initial:16}),cc=(await WebAssembly.instantiate(await readFile(file),{machine:{memory:cm}})).instance.exports;
  const c=new Uint8Array(cm.buffer),cv=new DataView(cm.buffer),input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
  c.fill(0x90,input,input+4096);c.set([0x48,0xf7,0xf3],input);assert.equal(cc.compiler_open_pages(input,1,0x400000n,9n),0);
  assert.equal(cc.compiler_emit(0x400000n,1,output,65536,report),0);const bytes=Number(cv.getBigUint64(report+40,true)),code=c.slice(output,output+bytes);
  const binding=cv.getUint32(report+76,true);cc.compiler_close();const memory=new WebAssembly.Memory({initial:1}),v=new DataView(memory.buffer);
  const cut=(await WebAssembly.instantiate(code,{machine:{memory}})).instance.exports.cut;
  const cpu=4096,port=8192;v.setBigUint64(port,9n,true);return {cut,v,cpu,port,binding,bytes};}
const [before,after]=await Promise.all([beforeFile,afterFile].map(prepare));
const inputs=[[1n,0xffffffffffffffffn,0x8000000000000001n],
  [0x8000000000000000n,0x123456789abcdef0n,0xffffffffffffffffn],
  [0xfffffffffffffffen,0xffffffffffffffffn,0xffffffffffffffffn]];
function run(engine,input,count){const {v,cpu,port,cut,binding}=engine,[h,l,d]=input;
  const start=performance.now();for(let n=0;n<count;++n){v.setBigUint64(cpu,l,true);v.setBigUint64(cpu+16,h,true);
    v.setBigUint64(cpu+24,d,true);v.setBigUint64(cpu+384,0x400000n,true);v.setBigUint64(cpu+392,0x202n,true);
    if(cut(cpu,port,0x400000n,binding)!==1n)throw new Error('unexpected cut result');}
  const elapsed=performance.now()-start,numerator=(h<<64n)|l;
  assert.equal(v.getBigUint64(cpu,true),numerator/d);assert.equal(v.getBigUint64(cpu+16,true),numerator%d);return elapsed;}
const observations=[];for(const input of inputs){run(before,input,10000);run(after,input,10000);const old=[],now=[];
  for(let repeat=0;repeat<7;++repeat){if(repeat&1){now.push(run(after,input,50000));old.push(run(before,input,50000));}
    else{old.push(run(before,input,50000));now.push(run(after,input,50000));}}
  const median=values=>values.slice().sort((a,b)=>a-b)[3],a=median(old),b=median(now);
  observations.push({input:input.map(x=>'0x'+x.toString(16)),calls:50000,beforeMs:a,afterMs:b,ratio:b/a});}
console.log(JSON.stringify({format:'wide-divide-execution-comparison-v1',status:'pass',observations,
  beforeCodeBytes:before.bytes,afterCodeBytes:after.bytes,metric:'median of seven, alternating order, same unavoidable JS state writes included; compile excluded',
  nativeReleaseSpeedup:'not-tested',linuxBoot:'not-tested'},null,2));
