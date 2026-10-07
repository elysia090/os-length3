// Actual native FILD observations -> common C cold compiler -> C MMU/table.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,compilerFile,directory]=process.argv.slice(2);
if(!directory)throw new Error('VM.WASM COLD.WASM HARDWARE-RECORDS');
const memory=new WebAssembly.Memory({initial:16}),vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cm=new WebAssembly.Memory({initial:16}),cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,dir=vm.vm_arena_min(),cpu=dir+4096,rows=dir+512,
  segments=cpu+1408,port=cpu+2048,codeView=port+64,entry=0x400000n;
const put=(at,x)=>v.setBigUint64(at,BigInt(x),true),table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));let comparisons=0,modules=0;
const cached=new Map();
for(let form=0;form<192;++form){const file=suffix=>readFile(path.join(directory,`x87-integer-${form}.${suffix}`));
  const meta=JSON.parse(await file('json')),source=await file('source'),native=await file('cases'),integers=await file('integers');
  assert.equal(meta.stateBytes,1256);assert.equal(native.length,64*2512);assert.equal(integers.length,512);
  let made=cached.get(meta.bytes);
  if(!made){c.fill(0x90,ci,ci+4096);c.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0,`FILD ${source.toString('hex')} must compile`);
    const n=Number(cv.getBigUint64(cr+40,true)),instance=(await WebAssembly.instantiate(c.subarray(co,co+n),
      {machine:{memory,access:vm.vm_access,floating_wait:vm.vm_floating_wait}})).instance;
    made={fn:instance.exports.cut,binding:cv.getUint32(cr+76,true)};cached.set(meta.bytes,made);++modules;cc.compiler_close();
  }
  for(let row=0;row<64;++row){vm.vm_close();a.fill(0,dir);
    const before=native.subarray(row*2512,row*2512+1256),after=native.subarray(row*2512+1256,(row+1)*2512);a.set(before,cpu);
    [0x1000,0x2000,0x3000,0x4000,0x8000].forEach((address,i)=>{
      put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
    put(cpu+8192,0x2067);put(cpu+12288,0x3067);put(cpu+16384+16,0x4067);put(cpu+20480,0x8067);
    a.fill(0x90,cpu+24576,cpu+28672);a.set(source,cpu+24576);a.set(integers.subarray(row*8,row*8+meta.bytes),cpu+24576+256);
    put(port,9);v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
    assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,5,5,dir+2048,9n),0);
    assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
    assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),made.fn);
    assert.equal(vm.vm_source_publish(6,1,made.binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    assert.equal(vm.vm_run(port,9n,1),1n);
    assert(a.subarray(cpu,cpu+1256).equals(after),`FILD full state ${form}/${row}`);++comparisons;
  }
}
vm.vm_close();console.log(JSON.stringify({format:'native-fild-c-v1',status:'pass',comparisons,modules,
  oracle:'physical Windows FPU/RFLAGS; compare GPR invariance architectural; PC/RC and stack occupancy/mask matrix',linuxBoot:'not-tested'},null,2));
