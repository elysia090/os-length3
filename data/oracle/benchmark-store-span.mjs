// Same provider and same ordinary unrolled x86 program. Host constructs only
// fixtures; retirement/memory/branches run in the C-owned table.
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const [vmFile,...compilers]=process.argv.slice(2);if(compilers.length!==2)throw new Error('VM.WASM BASELINE-COMPILER.WASM CURRENT-COMPILER.WASM');
const source=[0x48,0x89,0x07];for(let n=1;n<8;++n)source.push(0x48,0x89,0x47,n*8);const runs=[];
for(const compiler of compilers){const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:32});
 const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports,
 cc=(await WebAssembly.instantiate(await readFile(compiler),{machine:{memory:cm}})).instance.exports;
 const a=new Uint8Array(memory.buffer),v=new DataView(memory.buffer),c=new Uint8Array(cm.buffer),cv=new DataView(cm.buffer),
 dir=vm.vm_arena_min(),cpu=dir+4096,port=cpu+2048,segments=cpu+1408,rows=dir+512,codeView=port+64,
 input=cc.compiler_arena_min(),output=input+8192,report=output+65536,entry=0x400000n;
 const put=(at,x)=>v.setBigUint64(at,BigInt(x),true);
 for(const [i,address]of [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000].entries()){
 put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);}
 put(cpu+8192,0x2067);put(cpu+12288,0x3067);put(cpu+16384+16,0x4067);put(cpu+20480,0x8067);put(cpu+20480+256*8,0x9067);
 put(cpu+400,0x80010001);put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0xd00);put(cpu+384,entry);put(cpu+392,2);put(port,9);
 v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);a.set(source,cpu+24576);c.fill(0x90,input,input+4096);c.set(source,input);
 assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
 assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,6,6,dir+2048,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
 vm.__indirect_function_table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-vm.__indirect_function_table.length));
 const firstRow=dir+256;let blocks=0,totalBytes=0;
 for(let offset=0;offset<source.length;){assert.equal(cc.compiler_emit(entry+BigInt(offset),16,output,65536,report),0);
  const bytes=Number(cv.getBigUint64(report+40,true)),sourceBytes=Number(cv.getBigUint64(report+32,true)),instructions=Number(cv.getBigUint64(report+24,true));
  const fn=(await WebAssembly.instantiate(c.subarray(output,output+bytes),{machine:{memory,access:vm.vm_access}})).instance.exports.cut;
  assert.equal(vm.vm_source_query(port,entry+BigInt(offset),16,codeView,rows),1n);vm.__indirect_function_table.set(v.getUint32(rows+16,true),fn);
  assert.equal(vm.vm_source_publish(sourceBytes,instructions,cv.getUint32(report+76,true),rows),0);
  if(!offset)a.set(a.slice(rows,rows+24),firstRow);offset+=sourceBytes;++blocks;totalBytes+=bytes;
 }
 const reset=()=>{put(cpu,0x5a5a5a5a5a5a5a5an);put(cpu+56,0x500000);put(cpu+384,entry);put(cpu+392,2);put(cpu+1128,42);
  assert.equal(vm.vm_bind_execution(firstRow,1,9n),0);};
 const execute=()=>{assert.equal(vm.vm_run(port,9n,8),1n);assert.equal(vm.vm_source_retired(),8n);};
 for(let i=0;i<128;++i){reset();execute();}
 const samples=[];for(let round=0;round<7;++round){const start=performance.now();for(let n=0;n<16384;++n){reset();execute();}samples.push(performance.now()-start);}
 assert.equal(v.getBigUint64(cpu+1128,true),50n);assert.equal(v.getBigUint64(cpu+384,true),entry+31n);
 assert(a.subarray(cpu+28672,cpu+28736).every(x=>x===0x5a));
 runs.push({compiler,blocks,totalModuleBytes:totalBytes,medianMs:[...samples].sort((x,y)=>x-y)[3],samples});
}
console.log(JSON.stringify({format:'same-provider-store-span-benchmark-v1',sourceInstructions:8,iterationsPerSample:16384,runs,
 ratio:runs[1].medianMs/runs[0].medianMs,scope:'actual emitted Wasm/C table/source/MMU; reset/bind included; not Linux cold-ready'},null,2));
