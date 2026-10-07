// Architectural descriptor models through actual C-Wasm/MMU, not host UMIP emulation.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {seedDisabledDebug} from './machine-observation.mjs';
const [vmFile,compilerFile]=process.argv.slice(2);if(!compilerFile)throw new Error('VM.WASM COMPILER.WASM');
const ram=new WebAssembly.Memory({initial:16,maximum:32}),cm=new WebAssembly.Memory({initial:16,maximum:32});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory:ram}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(ram.buffer),v=new DataView(ram.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,dir=vm.vm_arena_min(),cpu=dir+4096,
  rows=dir+512,port=cpu+2048,segments=cpu+1408,codeView=port+64,code=cpu+24576,data=cpu+28672;
const table=vm.__indirect_function_table,slot=vm.vm_slot_min();table.grow(Math.max(0,slot+vm.vm_source_capacity()-table.length));
const put=(at,n)=>v.setBigUint64(at,BigInt.asUintN(64,BigInt(n)),true),entry=0x400000n;
const imports={memory:ram,access:vm.vm_access};let cases=0,faults=0,emissions=0;
const forms=[[],[0x66],[0x48],[0x67],[0x64],[0x65]];
for(const prefix of forms)for(const selector of [6,7]){
  const bytes=Buffer.from([...prefix,0x0f,0,selector===6?7:15]);c.fill(0x90,ci,ci+4096);c.set(bytes,ci);
  assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0,'system selector memory is a generic admission, not an opcode skip');
  assert.equal(cv.getUint32(cr+68,true),2,'memory write width is always two bytes');
  const fn=(await WebAssembly.instantiate(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))),{machine:imports})).instance.exports.cut;
  const binding=cv.getUint32(cr+76,true);++emissions;
  for(const cpl of [0,3])for(const umip of [0,1])for(const permission of ['write','readonly','absent'])for(const crossing of [false,true]){
    vm.vm_close();a.fill(0,dir);
    [0x1000,0x2000,0x3000,0x4000,0x8000,0x9000,0xa000].forEach((p,i)=>{
      put(dir+i*32,p);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
    put(cpu+8192,0x2067);put(cpu+12288,0x3067);put(cpu+16384+16,0x4067);
    put(cpu+20480,0x8067);put(cpu+20488,0x9067);
    put(cpu+20496,permission==='absent'?0:permission==='readonly'?0xa065:0xa067);
    if(!crossing)put(cpu+20488,permission==='absent'?0:permission==='readonly'?0x9065:0x9067);
    const address=crossing?0x401fffn:0x401010n;
    for(let r=0;r<16;++r)put(cpu+r*8,0x123456789abcdefn+BigInt(r));
    put(cpu+56,address);put(cpu+384,entry);put(cpu+392,0x10203);put(cpu+400,0x80010011);put(cpu+408,0x1000);
    put(cpu+416,0x6b0|(umip<<11));put(cpu+424,0xd01);put(cpu+488,8|cpl);put(cpu+528,0x1234face);put(cpu+536,0x5678beef);
    put(cpu+1128,41);put(port,9);seedDisabledDebug(v,cpu);v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
    // Explicit FS/GS have zero hidden base in this model, not a duplicate shadow.
    a.set(c.subarray(ci,ci+4096),code);a.fill(0xa5,data,data+8192);
    assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,7,7,dir+2048,9n),0);
    assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
    assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);
    table.set(v.getUint32(rows+16,true),fn);assert.equal(vm.vm_source_publish(bytes.length,1,binding,rows),0);
    assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    const before=Buffer.from(a.subarray(cpu,cpu+1256)),payload=Buffer.from(a.subarray(data,data+8192));
    const result=vm.vm_run(port,9n,1),expectedFault=cpl===3&&umip?13:permission!=='write'?14:0;
    if(expectedFault){assert.equal(result&7n,3n);assert.equal(v.getUint32(port+24,true),expectedFault);
      assert(a.subarray(cpu,cpu+1256).equals(before));assert(a.subarray(data,data+8192).equals(payload));++faults;
    }else{assert.equal(result&7n,1n);assert.equal(v.getBigUint64(cpu+384,true),entry+BigInt(bytes.length));
      assert.equal(v.getBigUint64(cpu+1128,true),42n);assert.equal(v.getBigUint64(cpu+392,true),0x203n);
      for(let r=0;r<16;++r)assert.equal(v.getBigUint64(cpu+r*8,true),before.readBigUInt64LE(r*8));
      const at=crossing?4095:16,value=selector===6?0xface:0xbeef;
      payload.writeUInt16LE(value,at);assert(a.subarray(data,data+8192).equals(payload));}
    ++cases;
  }
}
vm.vm_close();cc.compiler_close();console.log(JSON.stringify({status:'pass',emissions,cases,faults,
  oracle:'Intel selector/UMIP descriptor models + actual C MMU/table/atomic cross-page writes; not a native hardware proof',linuxBoot:'not-tested'}));
