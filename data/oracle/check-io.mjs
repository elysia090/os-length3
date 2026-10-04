// Native-C emission parity and complete generated-cut/C-device observations.
// Clock events are explicit test inputs. This is not a hardware/boot claim.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [vmFile,compilerFile,directory]=process.argv.slice(2);
if (!directory) throw new Error('usage: check-io.mjs VM.WASM COMPILER.WASM NATIVE-FIXTURE-DIRECTORY');
const memory=new WebAssembly.Memory({initial:8}), cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const cold=Buffer.from(cm.buffer), cv=new DataView(cm.buffer), input=cc.compiler_arena_min();
const output=input+8192, report=output+65536;
assert.equal(typeof vm.vm_io,'function','C device boundary must exist');
assert.equal(typeof vm.vm_time,'function','C clock boundary must exist');
const data=Buffer.from(memory.buffer), view=new DataView(memory.buffer), dir=vm.vm_arena_min();
const rows=dir+512, base=dir+4096, port=base+2048, segments=base+1408, code=base+24576, tss=base+28672;
const entry=0x400000n, put=(at,value)=>view.setBigUint64(at,BigInt(value),true);
const slot=vm.__indirect_function_table.grow(1);
let parity=0, comparisons=0, waits=0, refusals=0, events=0;
function reset(source,meta,cpl,iopl,sample) {
  data.fill(0,base);
  for (let i=0;i<6;++i) {
    const at=dir+i*32; put(at,i<4 ? (i+1)*4096 : (i+4)*4096);
    view.setUint32(at+8,(i+2)*4096,true); view.setUint32(at+12,3,true); view.setUint32(at+16,1,true);
    data.fill(0,at+20,at+32);
  }
  put(base+8192,0x2067); put(base+12288,0x3067); put(base+16384+16,0x4067);
  put(base+20480,0x8067); put(base+20488,0x9067); data.set(source,code);
  for (let reg=0;reg<16;++reg) put(base+reg*8,0xabcdef9800000000n+BigInt(reg*256+sample));
  put(base,0xabcdef9843210001n); put(base+16,0xabcdef9843210061n);
  put(base+384,entry); put(base+392,0x10202|(iopl<<12)); put(base+400,0x80010011);
  put(base+408,0x1000); put(base+416,32|(meta.time && sample&1 ? 4 : 0));
  put(base+424,0x500); put(base+488,16|cpl); put(base+1128,42); put(port,9);
  view.setUint32(segments,2,true); view.setUint32(segments+36,0xa09b,true);
  put(segments+120,0x401000); view.setUint32(segments+128,4095,true); view.setUint32(segments+132,0x8b,true);
  view.setUint16(tss+102,104,true); data[tss+104+(0x61>>3)]=sample&1 ? 1<<(0x61&7) : 0;
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,6,6,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
  put(rows,entry); view.setUint32(rows+8,meta.sourceBytes,true); view.setUint32(rows+12,1,true);
  view.setUint32(rows+16,slot,true); view.setUint32(rows+20,0,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
for (let rank=0;rank<26;++rank) {
  const prefix=path.join(directory,`io-${rank}`), meta=JSON.parse(await readFile(`${prefix}.json`));
  const source=await readFile(`${prefix}.source-page`), emitted=await readFile(`${prefix}.wasm`);
  cold.set(source,input); assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
  assert.equal(cv.getBigUint64(report+40,true),BigInt(emitted.length));
  assert(cold.subarray(output,output+emitted.length).equals(emitted)); ++parity;
  const module=await WebAssembly.compile(emitted);
  assert.deepEqual(WebAssembly.Module.imports(module),[
    {module:'machine',name:'memory',kind:'memory'}, {module:'machine',name:meta.time ? 'time' : 'io',kind:'function'}]);
  const cut=(await WebAssembly.instantiate(module,{machine:{memory,io:vm.vm_io,time:vm.vm_time}})).exports.cut;
  vm.__indirect_function_table.set(slot,cut);
  for (let cpl=0;cpl<4;++cpl) for (let iopl=0;iopl<4;++iopl) for (let sample=0;sample<8;++sample) {
    reset(source,meta,cpl,iopl,sample);
    const expected=Buffer.from(data.subarray(base,base+1256));
    const hidden=Buffer.from(data.subarray(segments,segments+136)), deviceBefore=Buffer.from(data.subarray(tss,tss+4096));
    const denied=meta.time ? cpl>0 && sample&1 : cpl>iopl && sample&1;
    const unavailable=!denied && !meta.time && meta.width!==1;
    assert.equal(vm.vm_run(port,9n,1),denied ? 107n : unavailable ? 6n : 18n);
    assert.equal(vm.vm_completed(),0); assert.equal(vm.vm_source_retired(),0n);
    assert(data.subarray(base,base+1256).equals(expected)); assert(data.subarray(segments,segments+136).equals(hidden));
    assert(data.subarray(tss,tss+4096).equals(deviceBefore));
    if (!denied && !unavailable) {
      const ticket=view.getBigUint64(port+32,true), ns=[0n,1n,0xffffffffn,0x100000000n,1n<<63n,0xffffffffffffffffn][sample%6];
      assert.equal(view.getUint32(port+40,true),0); assert.equal(view.getUint32(port+44,true),0x100);
      assert.equal(vm.vm_run(port,9n,1),18n); assert.equal(view.getBigUint64(port+32,true),ticket); ++waits;
      for (const [p,g,t,n] of [[port,8n,ticket,ns],[port+8,9n,ticket,ns],[port,9n,ticket+1n,ns]])
        assert.equal(vm.vm_clock_commit(p,g,t,n),-1);
      assert.equal(vm.vm_clock_commit(port,9n,ticket,ns),0);
      assert.equal(vm.vm_clock_commit(port,9n,ticket,ns),0);
      assert.equal(vm.vm_clock_commit(port,9n,ticket,BigInt.asUintN(64,ns+1n)),-1);
      assert.equal(vm.vm_run(port,9n,1),1n); assert.equal(vm.vm_completed(),1); assert.equal(vm.vm_source_retired(),1n);
      if (meta.time) { expected.writeBigUInt64LE(ns&0xffffffffn,0); expected.writeBigUInt64LE(ns>>32n,16); }
      else if (!meta.write) expected.writeBigUInt64LE(expected.readBigUInt64LE(0)&~((1n<<BigInt(meta.width*8))-1n),0);
      expected.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384); expected.writeBigUInt64LE(43n,1128);
      expected.writeBigUInt64LE(expected.readBigUInt64LE(392)&~0x10000n,392);
      ++events;
    } else { ++refusals; if (denied) { assert.equal(view.getUint32(port+24,true),13); assert.equal(view.getUint32(port+28,true),0); } }
    assert(data.subarray(base,base+1256).equals(expected)); assert(data.subarray(segments,segments+136).equals(hidden));
    ++comparisons;
  }
}
vm.__indirect_function_table.set(slot,null); cc.compiler_close(); vm.vm_close();
console.log(JSON.stringify({format:'c-wasm-io-clock-model-v1',status:'pass',parity,comparisons,waits,events,refusals,
  linuxBoot:'not-tested',oracle:'Intel permission/PIT model and native/cold C emission, not system-mode hardware'},null,2));
