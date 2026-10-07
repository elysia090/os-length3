// Independent native FPU observations. Kept red until exact emitted semantics
// exist; accepting a truncated/approximate comparison is not this gate.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,compilerFile,directory]=process.argv.slice(2);
if(!directory)throw new Error('VM.WASM COLD.WASM NATIVE-COMPARE-RECORDS');
const provenance=JSON.parse(await readFile(path.join(directory,'x87-compare-64.json')));
assert.equal(provenance.format,'native-x87-compare-observations-v2');
assert.equal(provenance.rows,16384);assert.equal(provenance.forms,64);
const memory=new WebAssembly.Memory({initial:16}),vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const coldMemory=new WebAssembly.Memory({initial:16}),cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:coldMemory}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(coldMemory.buffer),cv=new DataView(coldMemory.buffer);
const ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,dir=vm.vm_arena_min(),cpu=dir+4096,port=cpu+2048,
  segments=cpu+1408,rows=dir+512,codeView=port+64,entry=0x400000n;
const put=(at,n)=>v.setBigUint64(at,BigInt(n),true),table=vm.__indirect_function_table,slot=vm.vm_slot_min();
table.grow(Math.max(0,slot+vm.vm_source_capacity()-table.length));let comparisons=0;
// The real shipped make's first miss is FUCOMIP ST(0),ST(0). Preserve the
// entire matrix, but put that actual blocker first so the red is actionable.
for(const form of [8,...Array.from({length:64},(_,i)=>i).filter(i=>i!==8)]){const file=suffix=>readFile(path.join(directory,`x87-compare-${form}.${suffix}`));
  const meta=JSON.parse(await file('json')),source=await file('source'),native=await file('cases');
  assert.equal(meta.stateBytes,1256);assert.equal(native.length,meta.native*2512);
  c.fill(0x90,ci,ci+4096);c.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);
  const status=cc.compiler_emit(entry,1,co,65536,cr);
  assert.equal(status,0,`real x87 compare must lower exactly: form ${form}, source ${source.toString('hex')}`);
  const code=c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))),binding=cv.getUint32(cr+76,true);
  const instance=(await WebAssembly.instantiate(code,{machine:{memory,floating_wait:vm.vm_floating_wait}})).instance;cc.compiler_close();
  for(let row=0;row<meta.native;++row){vm.vm_close();a.fill(0,dir);
    const before=native.subarray(row*2512,row*2512+1256),after=native.subarray(row*2512+1256,(row+1)*2512);
    a.set(before,cpu);[0x1000,0x2000,0x3000,0x4000,0x8000].forEach((address,i)=>{
      put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
    put(cpu+8192,0x2067);put(cpu+12288,0x3067);put(cpu+16384+16,0x4067);put(cpu+20480,0x8067);
    a.fill(0x90,cpu+24576,cpu+28672);a.set(source,cpu+24576);put(port,9);v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
    assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,5,5,dir+2048,9n),0);
    assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
    assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),instance.exports.cut);
    assert.equal(vm.vm_source_publish(source.length,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    assert.equal(vm.vm_run(port,9n,1),1n);
    assert(a.subarray(cpu,cpu+1256).equals(after),`full native compare state: form ${form}, row ${row}`);++comparisons;
  }
}
vm.vm_close();console.log(JSON.stringify({format:'native-x87-compare-c-v1',status:'pass',comparisons,
  oracle:provenance.oracle,exceptionBoundaryScope:'separate C #NM/#MF/legacy FERR models required',linuxBoot:'not-tested'},null,2));
