// Native C emission -> exact cold C bytes -> real C IDT/MMU/frame provider.
// The independent system instruction oracle is check-exception.mjs.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [providerFile,compilerFile,directory]=process.argv.slice(2);
if(!directory)throw new Error('usage: check-software-interrupt.mjs VM.WASM COMPILER.WASM NATIVE-DIRECTORY');
const memory=new WebAssembly.Memory({initial:8}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(providerFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),cold=Buffer.from(cm.buffer),cv=new DataView(cm.buffer);
const dir=vm.vm_arena_min(),base=dir+4096,port=base+2048,segments=base+1408,rows=dir+512;
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536,entry=0x400000n;
const payload=i=>base+(i+1)*4096,put=(at,x)=>v.setBigUint64(at,BigInt(x),true);
const slot=vm.__indirect_function_table.grow(1),cpu=()=>Buffer.from(data.subarray(base,base+1256));
let parity=0,comparisons=0,waits=0,faults=0,refusals=0;
function reset(source,{gate=0x8e,flags=0x10603n,rsp=0xb100n,deferred=-1}={}) {
  data.fill(0,base);
  for(let i=0;i<10;++i) {
    const at=dir+i*32;put(at,(i<6?i+1:i+2)*4096);
    v.setUint32(at+8,(i+1)*4096,true);v.setUint32(at+12,3,true);
    v.setUint32(at+16,i===deferred?3:1,true);data.fill(0,at+20,at+32);
  }
  put(payload(0),0x2067);put(payload(1),0x3067);put(payload(2),0xe3);
  put(payload(2)+16,0x6067);put(payload(5),0x8067);
  put(payload(3)+8,0x00af9b000000ffffn);put(payload(3)+16,0x00cf93000000ffffn);
  put(payload(4)+48,0x9000n|8n<<16n|BigInt(gate)<<40n);
  data.set(source,payload(6));data.set([0x48,0xcf],payload(7));
  for(let r=0;r<16;++r)put(base+r*8,0xabcdef9887650000n+BigInt(r));
  put(base+32,rsp);put(base+384,entry);put(base+392,flags);put(base+400,0x80010011);
  put(base+408,0x1000);put(base+416,32);put(base+424,0x500);put(base+432,0xabcdef);
  put(base+448,0x4000);put(base+456,23);put(base+464,0x5000);put(base+472,4095);
  put(base+488,8);put(base+496,16);put(base+1128,42);put(port,9);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);v.setUint32(segments+52,0xc093,true);
  data.fill(0x93,payload(8),payload(8)+8192);
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,10,10,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
}
function bind(bytes) {
  put(rows,entry);v.setUint32(rows+8,bytes,true);v.setUint32(rows+12,1,true);v.setUint32(rows+16,slot,true);v.setUint32(rows+20,0,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
function expected(sourceBytes) {
  const state=cpu(),image=Buffer.from(data.subarray(payload(8),payload(8)+8192));
  const rsp=state.readBigUInt64LE(32),flags=state.readBigUInt64LE(392),target=(rsp&~15n)-40n;
  const frame=[entry+BigInt(sourceBytes),8n,flags&~0x10000n,rsp,16n];
  frame.forEach((word,i)=>image.writeBigUInt64LE(word,Number(target-0xa000n)+i*8));
  state.writeBigUInt64LE(target,32);state.writeBigUInt64LE(0x9000n,384);
  state.writeBigUInt64LE(flags&~(0x34100n|(data[payload(4)+53]===0x8e?0x200n:0n)),392);
  state.writeBigUInt64LE(43n,1128);
  return {state,image};
}
try {
  for(let form=0;form<8;++form) {
    const prefix=path.join(directory,`software-interrupt-${form}`);
    const meta=JSON.parse(await readFile(`${prefix}.json`)),source=await readFile(`${prefix}.source-page`),emitted=await readFile(`${prefix}.wasm`);
    cold.set(source,input);assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,8,output,65536,report),0);
    assert.equal(cv.getBigUint64(report+40,true),BigInt(emitted.length));assert(cold.subarray(output,output+emitted.length).equals(emitted));++parity;
    const module=await WebAssembly.compile(emitted);
    assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'},
      {module:'machine',name:'software_interrupt',kind:'function'}]);
    const cut=(await WebAssembly.instantiate(module,{machine:{memory,software_interrupt:vm.vm_software_interrupt}})).exports.cut;
    vm.__indirect_function_table.set(slot,cut);
    for(const dispatch of [false,true])for(const gate of [0x8e,0x8f])for(let align=0;align<16;++align)
    for(const rf of [0n,0x10000n]) {
      reset(source,{gate,rsp:0xb100n-BigInt(align),flags:0x603n|rf});bind(meta.sourceBytes);const result=expected(meta.sourceBytes);
      assert.equal(dispatch?vm.vm_run(port,9n,1):cut(base,port),dispatch?5n:1n);
      assert(cpu().equals(result.state));assert(data.subarray(payload(8),payload(8)+8192).equals(result.image));
      if(dispatch){assert.equal(vm.vm_completed(),1);assert.equal(vm.vm_source_retired(),1n);}++comparisons;
    }
    for(const dispatch of [false,true])for(const deferred of [3,4,8,9]) {
      reset(source,{rsp:0xb010n,deferred});bind(meta.sourceBytes);const before=cpu(),result=expected(meta.sourceBytes);
      assert.equal(dispatch?vm.vm_run(port,9n,1):cut(base,port),2n);assert(cpu().equals(before));
      if(dispatch){assert.equal(vm.vm_completed(),0);assert.equal(vm.vm_source_retired(),0n);}
      if(deferred===8) {
        // Two completed stores precede the lower-page wait. Keep them intact
        // and corrupt the consumed gate: retry must not read/replay it again.
        assert.equal(v.getBigUint64(payload(9),true),0xb010n);
        assert.equal(v.getBigUint64(payload(9)+8,true),16n);
        data.fill(0,payload(4)+48,payload(4)+64);
      }
      assert.equal(vm.vm_bind_execution(rows,1,9n),-1);
      assert.equal(vm.vm_fault(port),6n);assert(cpu().equals(before));
      v.setUint32(dir+deferred*32+16,1,true);
      assert.equal(dispatch?vm.vm_run(port,9n,1):cut(base,port),dispatch?5n:1n);
      assert(cpu().equals(result.state));assert(data.subarray(payload(8),payload(8)+8192).equals(result.image));
      if(dispatch){assert.equal(vm.vm_completed(),1);assert.equal(vm.vm_source_retired(),1n);}++waits;
    }
    for(const dispatch of [false,true])for(let mode=0;mode<6;++mode) {
      reset(source);bind(meta.sourceBytes);
      if(mode===0)put(base+472,47);
      if(mode===1)data[payload(4)+53]=0x0f;
      if(mode===2)data[payload(4)+53]=0x8d;
      if(mode===3)put(payload(4)+48,0x9000n|24n<<16n|0x8fn<<40n);
      if(mode===4)put(payload(3)+8,0x00af1b000000ffffn);
      if(mode===5)put(base+32,0x800000000000n);
      const before=cpu(),image=Buffer.from(data.subarray(payload(8),payload(8)+8192));
      const vector=mode===1||mode===4?11:mode===5?12:13;
      assert.equal(dispatch?vm.vm_run(port,9n,1):cut(base,port),(BigInt(vector)<<3n)|3n);
      assert(cpu().equals(before));assert(data.subarray(payload(8),payload(8)+8192).equals(image));
      assert.equal(v.getUint32(port+24,true),vector);if(dispatch)assert.equal(vm.vm_completed(),0);++faults;
    }
    for(const badPort of [port+1,base,base+8,base+1248,data.length-24,-1]) {
      reset(source);const before=cpu();assert.equal(cut(base,badPort),6n);assert(cpu().equals(before));++refusals;
    }
    reset(source);put(port,8);const before=cpu();assert.equal(cut(base,port),5n);assert(cpu().equals(before));++refusals;
  }
}finally{vm.__indirect_function_table.set(slot,null);vm.vm_close();}
console.log(JSON.stringify({status:'pass',nativeColdParity:parity,fullCpuFrameModels:comparisons,
  waitRetryModels:waits,deliveryFaultModels:faults,entryRefusals:refusals,
  oracle:'C-native emission parity plus architectural models; independent system #BP observations are separate',linuxBoot:'not-tested'}));
