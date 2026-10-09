// Paired execution of the same current SSA with versioned-old/current emission.
// Not compiler throughput, native Linux speed, or a browser boot benchmark.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
const [baselineFile,candidateFile,referenceDirectory]=process.argv.slice(2);
if(!referenceDirectory)throw new Error('BASELINE-COMPILER.WASM CANDIDATE-COMPILER.WASM NATIVE-REFERENCE-DIRECTORY');
const reference=await readFile(`${referenceDirectory}/scalar-integer-float-960.cases`);
const template=reference.subarray(17*2512,17*2512+1256),entry=0x400000n,cpu=8192,port=10240;
const programs=[{name:'i64-to-f64',source:[0xf2,0x48,0x0f,0x2a,0xc0]},
  {name:'i64-to-f32',source:[0xf3,0x48,0x0f,0x2a,0xc0]},
  {name:'ucomisd',source:[0x66,0x0f,0x2e,0xc1]}];
const providers=[];
for(const filename of [baselineFile,candidateFile]){
  const memory=new WebAssembly.Memory({initial:16}),cc=(await WebAssembly.instantiate(await readFile(filename),{machine:{memory}})).instance.exports;
  providers.push({memory,cc});
}
const results=[],iterations=400000;
for(const program of programs){const runners=[];
  for(const {memory:cm,cc} of providers){const c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536;
    c.fill(0x90,ci,ci+4096);c.set(program.source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);
    const size=Number(cv.getBigUint64(cr+40,true)),binding=cv.getUint32(cr+76,true),memory=new WebAssembly.Memory({initial:4});
    const cut=(await WebAssembly.instantiate(c.subarray(co,co+size),{machine:{memory}})).instance.exports.cut;
    const data=Buffer.from(memory.buffer),view=new DataView(memory.buffer);
    function reset(){data.set(template,cpu);view.setBigUint64(port,9n,true);view.setUint32(cpu+612,0x1f80,true);
      view.setBigUint64(cpu+128,0x3ff0000000000000n,true);view.setBigUint64(cpu+144,0x4000000000000000n,true);}
    function run(n){for(let i=0;i<n;++i){view.setBigUint64(cpu+384,entry,true);assert.equal(cut(cpu,port,entry,binding),1n);}}
    reset();run(1);const output=Buffer.from(data.subarray(cpu,cpu+1256));reset();run(12000);
    runners.push({reset,run,size,output});cc.compiler_close();
  }
  assert(runners[0].output.equals(runners[1].output),`${program.name} complete one-instruction state`);
  const times=[[],[]];
  for(let sample=0;sample<7;++sample)for(const which of (sample&1?[1,0]:[0,1])){
    runners[which].reset();const begin=performance.now();runners[which].run(iterations);times[which].push(performance.now()-begin);
  }
  const median=a=>a.slice().sort((x,y)=>x-y)[3],before=median(times[0]),after=median(times[1]);
  results.push({program:program.name,iterations,samples:7,baselineModuleBytes:runners[0].size,candidateModuleBytes:runners[1].size,
    baselineMs:before,candidateMs:after,ratio:after/before,rawMs:times});
}
console.log(JSON.stringify({format:'paired-scalar-ssa-execution-v1',results,
  scope:'Node direct compiled cuts; paired unchanged SSA/inputs; host reset/assert overhead included; no Linux/native/boot speed claim'},null,2));
