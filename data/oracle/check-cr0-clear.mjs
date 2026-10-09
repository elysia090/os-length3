// C control authority / privilege / exact TS field models, not native evidence.
import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile,nativeArgument]=process.argv.slice(2);if(!compilerFile)throw new Error('VM.WASM COMPILER.WASM [NATIVE-CPL0.LOG|--cache]');
const cache=nativeArgument==='--cache',nativeFile=cache?undefined:nativeArgument;
const memory=new WebAssembly.Memory({initial:16}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports,cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const a=Buffer.from(memory.buffer),v=new DataView(memory.buffer),c=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),dir=vm.vm_arena_min(),cpu=dir+4096,rows=dir+512,segments=cpu+1408,port=cpu+2048,codeView=port+64;
const ci=cc.compiler_arena_min(),co=ci+8192,cr=co+65536,entry=0x400000n,put=(at,x)=>v.setBigUint64(at,BigInt(x),true),table=vm.__indirect_function_table;
table.grow(Math.max(0,vm.vm_slot_min()+vm.vm_source_capacity()-table.length));let comparisons=0,gp=0,changed=0,identity=0;
for(const opcode of cache?[8,9]:[6])for(const prefix of [[],[0x66],[0x67],[0x48],[0xf2],[0xf3],[0x64],[0x65]]){
  if(cache&&prefix[0]===0xf3)continue; // WBNOINVD is a distinct, unadmitted CPU feature.
  const source=Buffer.from([...prefix,0x0f,opcode]);c.fill(0x90,ci,ci+4096);c.set(source,ci);
  assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);
  const binding=cv.getUint32(cr+76,true),cut=(await WebAssembly.instantiate(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))),{machine:{memory,control:vm.vm_control}})).instance.exports.cut;cc.compiler_close();
  for(const dispatch of [false,true])for(let cpl=0;cpl<4;++cpl)for(let bits=0;bits<16;++bits){vm.vm_close();a.fill(0,dir);
    [0x1000,0x2000,0x3000,0x4000,0x8000].forEach((address,i)=>{put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
    put(cpu+8192,0x2067);put(cpu+12288,0x3067);put(cpu+16384+16,0x4067);put(cpu+20480,0x8067);a.set(source,cpu+24576);
    const cr0=0x80010011n|BigInt(bits&7)<<1n|(bits&8?32n:0n);
    put(cpu+384,entry);put(cpu+392,0x10a93);put(cpu+400,cr0);put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0x500);put(cpu+488,8|cpl);put(cpu+600,0x400);put(cpu+1128,42);put(port,9);
    v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b|(cpl<<5),true);
    assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,5,5,dir+2048,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
    assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),cut);assert.equal(vm.vm_source_publish(source.length,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    const before=Buffer.from(a.subarray(cpu,cpu+1256)),expected=Buffer.from(before),result=dispatch?vm.vm_run(port,9n,1):cut(cpu,port,entry,binding);
    if(cpl){assert.equal(result,107n);assert.equal(v.getUint32(port+24,true),13);assert.equal(v.getUint32(port+28,true),0);++gp;}
    else{assert.equal(result,dispatch&&!cache&&(cr0&8n)?5n:1n);expected.writeBigUInt64LE(cache?cr0:cr0&~8n,400);expected.writeBigUInt64LE(entry+BigInt(source.length),384);expected.writeBigUInt64LE(0xa93n,392);expected.writeBigUInt64LE(43n,1128);!cache&&(cr0&8n)?++changed:++identity;}
    assert(a.subarray(cpu,cpu+1256).equals(expected));if(dispatch)assert.equal(vm.vm_source_retired(),cpl?0n:1n);++comparisons;
  }
}
let nativeComparisons=0;
if(nativeFile){const native=(await readFile(nativeFile,'utf8')).trim().split(/\r?\n/).map(line=>line.trim().split(/\s+/).map(word=>BigInt(`0x${word}`)));
  assert.equal(native.length,128);
  for(let prefix=0;prefix<8;++prefix){const bytes=[[],[0x66],[0x67],[0x48],[0xf2],[0xf3],[0x64],[0x65]][prefix],source=Buffer.from([...bytes,0x0f,6]);
    c.fill(0x90,ci,ci+4096);c.set(source,ci);assert.equal(cc.compiler_open_pages(ci,1,entry,9n),0);assert.equal(cc.compiler_emit(entry,1,co,65536,cr),0);
    const binding=cv.getUint32(cr+76,true),cut=(await WebAssembly.instantiate(c.subarray(co,co+Number(cv.getBigUint64(cr+40,true))),{machine:{memory,control:vm.vm_control}})).instance.exports.cut;cc.compiler_close();
    for(let bits=0;bits<16;++bits)for(const dispatch of [false,true]){const receipt=native[prefix*16+bits];assert.equal(receipt[0],BigInt(prefix*16+bits));
      vm.vm_close();a.fill(0,dir);[0x1000,0x2000,0x3000,0x4000,0x8000].forEach((address,i)=>{put(dir+i*32,address);v.setUint32(dir+i*32+8,(i+2)*4096,true);v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);});
      put(cpu+8192,0x2067);put(cpu+12288,0x3067);put(cpu+16384+16,0x4067);put(cpu+20480,0x8067);a.set(source,cpu+24576);
      put(cpu+384,entry);put(cpu+392,receipt[3]);put(cpu+400,receipt[1]);put(cpu+408,0x1000);put(cpu+416,32);put(cpu+424,0x500);put(cpu+488,8);put(cpu+600,0x400);put(cpu+1128,42);put(port,9);
      v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);assert.equal(vm.vm_open(cpu,a.length-cpu,4096,dir,5,5,dir+2048,9n),0);assert.equal(vm.vm_bind_state(cpu),0);assert.equal(vm.vm_bind_segments(segments),0);
      assert.equal(vm.vm_source_query(port,entry,1,codeView,rows),1n);table.set(v.getUint32(rows+16,true),cut);assert.equal(vm.vm_source_publish(source.length,1,binding,rows),0);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
      assert.equal(dispatch?vm.vm_run(port,9n,1):cut(cpu,port,entry,binding),dispatch&&(receipt[1]&8n)?5n:1n);
      assert.equal(v.getBigUint64(cpu+400,true),receipt[2]);assert.equal(v.getBigUint64(cpu+392,true),receipt[4]);assert.equal(v.getBigUint64(cpu+1128,true),43n);++nativeComparisons;
    }
  }
}
vm.vm_close();console.log(JSON.stringify({status:'pass',mode:cache?'cache-barrier':'clear-TS',comparisons,gp,changed,identity,nativeComparisons,scope:'CPL0..3 models; optional independent CPL0 CR0/RFLAGS comparisons; old context revoked only when TS changes; no memory',linuxBoot:'not-tested'}));
