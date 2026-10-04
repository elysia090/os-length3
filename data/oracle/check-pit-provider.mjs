// Cold C emission -> generated IN/OUT -> actual C PIT/clock/PIC/MMU.
// Explicit nanosecond test events, not a JavaScript product device model.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile]=process.argv.slice(2);
if(!compilerFile)throw new Error('usage: check-pit-provider.mjs VM.WASM COMPILER.WASM');
const memory=new WebAssembly.Memory({initial:8}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),cold=new Uint8Array(cm.buffer),cv=new DataView(cm.buffer);
const dir=vm.vm_arena_min(),base=dir+4096,segments=base+1408,port=base+2048,rows=dir+512,code=base+24576,tss=base+28672;
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536,entry=0x400000n;
const put=(at,x)=>v.setBigUint64(at,BigInt(x),true),get=at=>v.getBigUint64(at,true);
const slot=vm.__indirect_function_table.grow(1),cuts=new Map();
let comparisons=0,waits=0,faults=0,refusals=0,events=0,irqEdges=0;
const nsAt=t=>(BigInt(t)*1000000000n+1193181n)/1193182n;
function reset(){
  data.fill(0,base);
  for(let i=0;i<6;++i){const at=dir+i*32;put(at,i<4?(i+1)*4096:(i+4)*4096);
    v.setUint32(at+8,(i+2)*4096,true);v.setUint32(at+12,3,true);v.setUint32(at+16,1,true);data.fill(0,at+20,at+32);}
  put(base+8192,0x2067);put(base+12288,0x3067);put(base+16384+16,0x4067);
  put(base+20480,0x8067);put(base+20488,0x9067);
  for(let r=0;r<16;++r)put(base+r*8,0xabcdef9887650000n+BigInt(r));
  put(base+384,entry);put(base+392,0x10443);put(base+400,0x80010011);put(base+408,0x1000);
  put(base+416,32);put(base+424,0x500);put(base+488,16);put(base+1128,42);put(port,9);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);
  put(segments+120,0x401000);v.setUint32(segments+128,4095,true);v.setUint32(segments+132,0x8b,true);
  v.setUint16(tss+102,104,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,6,6,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
}
async function compile(write,width,immediate){
  const bytes=immediate!==undefined?[write?0xe6:0xe4,immediate]:
    [...(width===2?[0x66]:[]),write?width===1?0xee:0xef:width===1?0xec:0xed];
  const key=bytes.join(',');if(cuts.has(key))return cuts.get(key);
  cold.fill(0x90,input,input+4096);cold.set(bytes,input);
  assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
  const module=await WebAssembly.compile(cold.slice(output,output+Number(cv.getBigUint64(report+40,true))));
  const cut=(await WebAssembly.instantiate(module,{machine:{memory,io:vm.vm_io}})).exports.cut;
  const result={bytes,cut};cuts.set(key,result);return result;
}
async function transfer(coordinate,write,byte,tick,wanted=0,{width=1,cpl=0,iopl=0,deny=false,refuse=false,immediate=false,pin=false,synchronous=false}={}){
  const {bytes,cut}=await compile(write,width,immediate?coordinate:undefined);
  vm.__indirect_function_table.set(slot,cut);data.set(bytes,code);
  put(base,0xabcdef9843210000n|BigInt(byte));put(base+16,0xabcdef9800000000n|BigInt(coordinate));
  put(base+384,entry);put(base+392,0x10443|(iopl<<12));put(base+488,16|cpl);
  data.fill(0,tss+104,tss+4096);if(deny)data[tss+104+(coordinate>>3)]=1<<(coordinate&7);
  v.setUint32(segments+4,2,true);
  put(rows,entry);v.setUint32(rows+8,bytes.length,true);v.setUint32(rows+12,1,true);
  v.setUint32(rows+16,slot,true);v.setUint32(rows+20,0,true);assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  const expected=Buffer.from(data.subarray(base,base+1256)),hidden=Buffer.from(data.subarray(segments,segments+136));
  const denied=cpl>iopl&&deny,result=denied?107n:width!==1||refuse?6n:synchronous?1n:18n;
  assert.equal(vm.vm_run(port,9n,1),result,`${coordinate.toString(16)} ${write} ${byte}`);
  if(result===1n){
    assert.equal(vm.vm_completed(),1);assert.equal(vm.vm_source_retired(),1n);
    expected.writeBigUInt64LE(entry+BigInt(bytes.length),384);expected.writeBigUInt64LE(expected.readBigUInt64LE(1128)+1n,1128);
    expected.writeBigUInt64LE(expected.readBigUInt64LE(392)&~0x10000n,392);hidden.writeUInt32LE(0,4);
    assert(data.subarray(base,base+1256).equals(expected));assert(data.subarray(segments,segments+136).equals(hidden));
    assert.equal(vm.vm_post_read(9n),byte);assert.equal(vm.vm_post_read(8n),-1);++comparisons;return;
  }
  assert.equal(vm.vm_completed(),0);assert.equal(vm.vm_source_retired(),0n);
  assert(data.subarray(base,base+1256).equals(expected));assert(data.subarray(segments,segments+136).equals(hidden));
  if(result===107n){assert.equal(v.getUint32(port+24,true),13);++faults;}
  else if(result===6n)++refusals;
  else{
    const ticket=get(port+32),ns=nsAt(tick);++waits;
    assert.equal(vm.vm_run(port,9n,1),18n);assert.equal(get(port+32),ticket);
    assert.equal(vm.vm_clock_commit(port,8n,ticket,ns),-1);
    assert.equal(vm.vm_clock_commit(port+8,9n,ticket,ns),-1);
    assert.equal(vm.vm_clock_commit(port,9n,ticket+1n,ns),-1);
    assert.equal(vm.vm_clock_commit(port,9n,ticket,ns),0);assert.equal(vm.vm_clock_commit(port,9n,ticket,ns),0);++events;
    assert(data.subarray(base,base+1256).equals(expected));assert(data.subarray(segments,segments+136).equals(hidden));
    if(pin){data[code]=0xf4;put(base+20480,0x8000000000008067n);v.setUint32(rows+16,0xffffffff,true);}
    assert.equal(vm.vm_run(port,9n,1),1n);assert.equal(vm.vm_completed(),1);assert.equal(vm.vm_source_retired(),1n);
    expected.writeBigUInt64LE(entry+BigInt(bytes.length),384);expected.writeBigUInt64LE(expected.readBigUInt64LE(1128)+1n,1128);
    expected.writeBigUInt64LE(expected.readBigUInt64LE(392)&~0x10000n,392);hidden.writeUInt32LE(0,4);
    if(!write)expected.writeBigUInt64LE((expected.readBigUInt64LE(0)&~255n)|BigInt(wanted),0);
    assert(data.subarray(base,base+1256).equals(expected));assert(data.subarray(segments,segments+136).equals(hidden));
    if(pin)put(base+20480,0x8067);
  }
  ++comparisons;
}
reset();await transfer(0x43,1,0x34,0,0,{immediate:true,pin:true}); // Real pre-mode2 provider red.
for(let channel=0;channel<3;++channel)for(const mode of [2,6])
for(let cpl=0;cpl<4;++cpl)for(let iopl=0;iopl<4;++iopl)for(const width of [1,2,4])for(const deny of [false,true]){
  reset();await transfer(0x43,1,(channel<<6)|0x30|(mode<<1),0,0,{cpl,iopl,width,deny});
}
for(const command of [0x31,0x32,0x36,0x38,0x3a,0x35]){reset();await transfer(0x43,1,command,0,0,{refuse:true});}
for(const divisor of [2,3,4,255,256,257,65535,65536])for(const channel of [0,1,2])for(const mode of [2,6]){
  reset();if(channel===2)await transfer(0x61,1,1,0);
  await transfer(0x43,1,(channel<<6)|0x30|(mode<<1),0);
  await transfer(0x40+channel,1,divisor&255,0);await transfer(0x40+channel,1,(divisor>>8)&255,0);
  for(const tick of [1,divisor,divisor+1,divisor*3+1]){
    const remaining=divisor-(tick-1)%divisor;
    await transfer(0x43,1,0xc0|(2<<channel),tick);
    await transfer(0x40+channel,0,0,tick,(remaining===1?0:128)|0x30|(mode<<1));
    await transfer(0x40+channel,0,0,tick,remaining&255);await transfer(0x40+channel,0,0,tick,(remaining>>8)&255);
  }
}
// Clock commit drives real C IRQ0, including a pulse skipped by a coarse
// sample. Duplicate/old reply cannot create another pending edge after poll.
reset();await transfer(0x43,1,0x34,0);await transfer(0x40,1,4,0);await transfer(0x40,1,0,0);
const io=(p,w,x=0)=>{assert.equal(vm.vm_io(port,p,1|(w<<8),BigInt(x)),0n);return get(port+8);};
io(0x20,1,0x0c);assert.equal(io(0x20,0),128n);io(0x20,1,0x20); // Initial high is a real edge.
assert.equal(vm.vm_time(port),18n);const ticket=get(port+32),later=nsAt(41);
assert.equal(vm.vm_clock_commit(port,9n,ticket,later),0);assert.equal(vm.vm_time(port),0n);
io(0x20,1,0x0c);assert.equal(io(0x20,0),128n);++irqEdges;io(0x20,1,0x20);
assert.equal(vm.vm_clock_commit(port,9n,ticket,later),0);io(0x20,1,0x0c);assert.equal(io(0x20,0),0n);
assert.equal(vm.vm_clock_commit(port,9n,ticket,later-1n),-1);io(0x20,1,0x0c);assert.equal(io(0x20,0),0n);
// The next actual Linux refusal was OUT 80h, AL. It has a C-owned,
// supervisor-observable POST latch, not an ignored guest instruction.
reset();await transfer(0x80,1,0,0,0,{immediate:true,synchronous:true});
for(let byte=0;byte<256;++byte)await transfer(0x80,1,byte,0,0,{synchronous:true});
for(let cpl=0;cpl<4;++cpl)for(let iopl=0;iopl<4;++iopl)for(const width of [1,2,4])for(const deny of [false,true]){
  reset();await transfer(0x80,1,0x5a,0,0,{cpl,iopl,width,deny,synchronous:true});
  if(cpl>iopl&&deny||width!==1)assert.equal(vm.vm_post_read(9n),-1);
}
reset();await transfer(0x80,0,0,0,0,{refuse:true});assert.equal(vm.vm_post_read(9n),-1);
assert.equal(vm.vm_time(port),18n);assert.equal(vm.vm_io(port,0x80,0x101,1n),6n);assert.equal(vm.vm_post_read(9n),-1);
reset();assert.equal(vm.vm_post_read(9n),-1);vm.vm_close();assert.equal(vm.vm_post_read(9n),-1);
console.log(JSON.stringify({format:'compiled-pit-c-provider-v1',status:'pass',modules:cuts.size,comparisons,waits,events,faults,refusals,irqEdges,
  oracle:'Intel pulse/permission model, C clock/PIC and complete CPU/segment comparison; independent device/system tests separate',linuxBoot:'not-tested'},null,2));
