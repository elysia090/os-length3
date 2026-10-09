// Actual emitted x86 stores through C. Expected store/fault/prefix formulas
// are architectural models here, not an independent hardware observation.
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile]=process.argv.slice(2);if(!compilerFile)throw new Error('VM.WASM COMPILER.WASM');
const cm=new WebAssembly.Memory({initial:32}),cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const c=new Uint8Array(cm.buffer),cv=new DataView(cm.buffer),input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const source=[0x48,0x89,0x07];for(let n=1;n<8;++n)source.push(0x48,0x89,0x47,n*8);
c.fill(0x90,input,input+4096);c.set(source,input);const entry=0x400000n;
assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);assert.equal(cc.compiler_emit(entry,16,output,65536,report),0);
assert.equal(cv.getBigUint64(report+24,true),8n);assert.equal(cv.getBigUint64(report+32,true),31n);
const emitted=Uint8Array.from(c.subarray(output,output+Number(cv.getBigUint64(report+40,true))));
let cases=0;
for(let mode=0;mode<6;++mode){const memory=new WebAssembly.Memory({initial:16}),vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
 const a=new Uint8Array(memory.buffer),v=new DataView(memory.buffer),dir=vm.vm_arena_min(),cpu=dir+4096,port=cpu+2048,segments=cpu+1408,rows=dir+512,codeView=port+64;
 const put=(at,x)=>v.setBigUint64(at,BigInt(x),true),word=0x123456789abcdef0n;
 for(const [i,address]of [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000,0xa000].entries()){
  put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);}
 put(cpu+8192,0x2067);put(cpu+12288,0x3067);put(cpu+16384+16,0x4067);put(cpu+20480,0x8067);
 put(cpu+20480+256*8,mode===5?0x4067:0x9067);put(cpu+20480+257*8,mode===1||mode===3?0:0xa067);
 put(cpu,mode===4||mode===5?0:word);put(cpu+56,mode===4?entry:mode===1?0x500ff0n:mode===2||mode===3?0x500ff9n:0x500000n);
 put(cpu+384,entry);put(cpu+392,0x10202);put(cpu+400,0x80010001);put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0xd00);put(cpu+1128,42);
 a.set(source,cpu+24576);put(port,9);v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
 assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,7,7,dir+2048,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
 vm.__indirect_function_table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-vm.__indirect_function_table.length));
 const fn=(await WebAssembly.instantiate(emitted,{machine:{memory,access:vm.vm_access}})).instance.exports.cut;
 assert.equal(vm.vm_source_query(port,entry,16,codeView,rows),1n);vm.__indirect_function_table.set(v.getUint32(rows+16,true),fn);
 assert.equal(vm.vm_source_publish(31,8,0,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
 const result=vm.vm_run(port,9n,1),completed=mode===0?8:mode===1?2:mode===3?0:1;
 assert.equal(result,mode===3?115n:mode===4?5n:1n,`mode${mode}`);assert.equal(vm.vm_source_retired(),BigInt(completed));
 assert.equal(v.getBigUint64(cpu+1128,true),42n+BigInt(completed));
 assert.equal(v.getBigUint64(cpu+384,true),entry+BigInt(completed?4*completed-1:0));
 assert.equal(v.getBigUint64(cpu+392,true),BigInt(completed?0x202:0x10202));
 if(mode===0)for(let n=0;n<8;++n)assert.equal(v.getBigUint64(cpu+28672+n*8,true),word);
 if(mode===1){assert.equal(v.getBigUint64(cpu+28672+4080,true),word);assert.equal(v.getBigUint64(cpu+28672+4088,true),word);}
 if(mode===3){assert(a.subarray(cpu+28672,cpu+32768).every(x=>x===0));assert.equal(v.getBigUint64(port+16,true),0x501000n);}
 if(mode===5){assert.equal(v.getBigUint64(cpu+20480,true),0n);assert.equal(vm.vm_run(port,9n,1),115n);
  assert.equal(vm.vm_source_retired(),0n);assert.equal(v.getBigUint64(port+16,true),entry+3n);assert.equal(v.getBigUint64(cpu+1128,true),43n);}
 ++cases;
}
console.log(JSON.stringify({format:'compiled-store-prefix-c-model-v1',status:'pass',cases,
 scope:'full store/page-clipped prefix/cross-page atomic fault/code-byte alias/code-translation alias; RF/retirement and source fetch; not native CPU or Linux boot'},null,2));
