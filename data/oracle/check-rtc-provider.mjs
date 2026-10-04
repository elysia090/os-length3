// Cold C compiler -> generated IN/OUT -> actual C-Wasm RTC/MMU/dispatcher.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile]=process.argv.slice(2);
if (!compilerFile) throw new Error('usage: check-rtc-provider.mjs VM.WASM COMPILER.WASM');
const memory=new WebAssembly.Memory({initial:8}),cm=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const cold=Buffer.from(cm.buffer),cv=new DataView(cm.buffer),input=cc.compiler_arena_min();
const output=input+8192,report=output+65536,entry=0x400000n;
const data=Buffer.from(memory.buffer),view=new DataView(memory.buffer),dir=vm.vm_arena_min();
const rows=dir+512,base=dir+4096,port=base+2048,segments=base+1408,code=base+24576,tss=base+28672;
const slot=vm.__indirect_function_table.grow(1),put=(at,v)=>view.setBigUint64(at,BigInt(v),true);
function reset(seed=true) {
  data.fill(0,base);
  for (let i=0;i<6;++i) {
    const at=dir+i*32; put(at,i<4 ? (i+1)*4096 : (i+4)*4096);
    view.setUint32(at+8,(i+2)*4096,true); view.setUint32(at+12,3,true); view.setUint32(at+16,1,true);
    data.fill(0,at+20,at+32);
  }
  put(base+8192,0x2067); put(base+12288,0x3067); put(base+16384+16,0x4067);
  put(base+20480,0x8067); put(base+20488,0x9067);
  for (let r=0;r<16;++r) put(base+r*8,0xabcdef9887650000n+BigInt(r));
  put(base+384,entry); put(base+392,0x10002); put(base+400,0x80010011); put(base+408,0x1000);
  put(base+416,32); put(base+424,0x500); put(base+488,16); put(base+1128,42); put(port,9);
  view.setUint32(segments,1,true); view.setUint32(segments+36,0xa09b,true);
  put(segments+120,0x401000); view.setUint32(segments+128,4095,true); view.setUint32(segments+132,0x8b,true);
  view.setUint16(tss+102,104,true);
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,6,6,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
  assert.equal(vm.vm_rtc_start(port,8n,0n),-1);
  assert.equal(vm.vm_rtc_start(port,9n,253402300800n),-1);
  if (seed) {
    assert.equal(vm.vm_rtc_start(port,9n,1791117296n),0);
    assert.equal(vm.vm_rtc_start(port,9n,0n),-1);
  }
}
const cuts=new Map();
async function compile(bytes) {
  const key=bytes.join(','); if (cuts.has(key)) return cuts.get(key);
  cold.fill(0,input,input+4096); cold.set(bytes,input);
  assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
  const module=await WebAssembly.compile(cold.subarray(output,output+Number(cv.getBigUint64(report+40,true))));
  assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'},
    {module:'machine',name:'io',kind:'function'}]);
  const cut=(await WebAssembly.instantiate(module,{machine:{memory,io:vm.vm_io}})).exports.cut;
  cuts.set(key,cut); return cut;
}
let comparisons=0,faults=0,waits=0,refusals=0,replays=0;
async function run(coordinate,write,width,value,expectedByte=0,ns=0n,{cpl=0,iopl=0,bit=-1,refuse=false,dx=false}={}) {
  const bytes=[]; if (width===2) bytes.push(0x66);
  if (dx) bytes.push(write ? width===1 ? 0xee : 0xef : width===1 ? 0xec : 0xed);
  else bytes.push(write ? width===1 ? 0xe6 : 0xe7 : width===1 ? 0xe4 : 0xe5,coordinate);
  vm.__indirect_function_table.set(slot,await compile(bytes)); data.fill(0,code,code+4096); data.set(bytes,code);
  put(base+384,entry); put(base,0xabcdef9843210000n|BigInt(value));
  put(base+16,0xabcdef9800000000n|BigInt(coordinate)); put(base+488,16|cpl); put(base+392,0x10002|(iopl<<12));
  data.fill(0,tss+104,tss+4096); if (bit>=0) view.setUint16(tss+104+(coordinate>>3),1<<bit,true);
  put(rows,entry); view.setUint32(rows+8,bytes.length,true); view.setUint32(rows+12,1,true);
  view.setUint32(rows+16,slot,true); view.setUint32(rows+20,0,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  const expected=Buffer.from(data.subarray(base,base+1256)),hidden=Buffer.from(data.subarray(segments,segments+136));
  const denied=cpl>iopl && bit>=0 && ((1<<bit)&(((1<<width)-1)<<(coordinate&7)));
  const result=denied ? 107n : width!==1 || refuse ? 6n : 1n;
  let actual=vm.vm_run(port,9n,1);
  if (actual===18n) {
    assert.equal(coordinate,0x71); ++waits;
    assert(data.subarray(base,base+1256).equals(expected),'wait publishes no CPU changes');
    const ticket=view.getBigUint64(port+32,true);
    assert.equal(vm.vm_run(port,9n,1),18n); assert.equal(view.getBigUint64(port+32,true),ticket);
    assert.equal(vm.vm_clock_commit(port,8n,ticket,ns),-1);
    assert.equal(vm.vm_clock_commit(port,9n,ticket+1n,ns),-1);
    assert.equal(vm.vm_clock_commit(port+8,9n,ticket,ns),-1);
    put(base+384,entry+1n); assert.equal(vm.vm_clock_commit(port,9n,ticket,ns),-1); put(base+384,entry);
    assert.equal(vm.vm_io(port,0x70,0x101,12n),cpl>iopl && bit===0 ? 107n : 6n,
      'I/O permission precedes the pending-index guard; neither can steal the RTC ticket');
    assert.equal(vm.vm_rtc_start(port,9n,0n),-1);
    assert.equal(vm.vm_clock_commit(port,9n,ticket,ns),0);
    assert.equal(vm.vm_clock_commit(port,9n,ticket,ns),0);
    assert.equal(vm.vm_clock_commit(port,9n,ticket,ns+1n),-1);
    actual=vm.vm_run(port,9n,1);
    if (result===1n) { assert.equal(vm.vm_clock_commit(port,9n,ticket,ns),0); ++replays; }
  }
  assert.equal(actual,result,`${coordinate.toString(16)} ${write} ${width} ${value}`);
  if (result===1n) {
    expected.writeBigUInt64LE(entry+BigInt(bytes.length),384); expected.writeBigUInt64LE(expected.readBigUInt64LE(1128)+1n,1128);
    expected.writeBigUInt64LE(expected.readBigUInt64LE(392)&~0x10000n,392);
    if (!write) expected.writeBigUInt64LE((expected.readBigUInt64LE(0)&~255n)|BigInt(expectedByte),0);
    assert.equal(vm.vm_completed(),1); assert.equal(vm.vm_source_retired(),1n);
  } else {
    assert.equal(vm.vm_completed(),0); assert.equal(vm.vm_source_retired(),0n);
    if (denied) { assert.equal(view.getUint32(port+24,true),13); ++faults; } else ++refusals;
  }
  assert(data.subarray(base,base+1256).equals(expected),'complete CPU after generated RTC cut');
  assert(data.subarray(segments,segments+136).equals(hidden)); ++comparisons;
}
async function select(index) { await run(0x70,true,1,index); }
for (const coordinate of [0x70,0x71]) for (let cpl=0;cpl<4;++cpl) for (let iopl=0;iopl<4;++iopl)
for (const width of [1,2,4]) for (let bit=0;bit<16;++bit) for (const dx of [false,true]) {
  reset(); await run(coordinate,false,width,0,coordinate===0x70 ? 255 : 0x56,0n,{cpl,iopl,bit,dx});
}
reset();
for (const [index,byte] of [[0,0x56],[2,0x34],[4,0x12],[6,1],[7,4],[8,0x10],[9,0x26],[0x32,0x20],[0x37,0x20],[10,0x26],[11,2],[13,128]]) {
  await select(index); await run(0x71,false,1,0,byte);
}
for (let index=14;index<128;++index) if (index!==0x32 && index!==0x37)
for (const byte of [0,255,index,255-index]) {
  await select(index|128); await run(0x71,true,1,byte); await run(0x71,false,1,0,byte);
}
reset(); await select(10); await run(0x71,false,1,0,0xa6,999800000n);
await run(0x71,false,1,0,0x26,1000000000n); await select(0); await run(0x71,false,1,0,0x57,1000000000n);
await select(12); await run(0x71,false,1,0,0x50,1000000000n); await run(0x71,false,1,0,0,1000000000n);
await select(11); await run(0x71,true,1,0x42,0,1000000000n);
await select(12); await run(0x71,false,1,0,0xc0,1001000000n); await run(0x71,false,1,0,0,1001000000n);
// IRQ8 reaches the C slave request register, not an injected CPU interrupt.
await select(11); await run(0x71,true,1,0x42,0,1002000000n);
assert.equal(vm.vm_io(port,0xa0,0x101,0x0an),0n); assert.equal(vm.vm_io(port,0xa0,1,0n),0n);
assert.equal(view.getBigUint64(port+8,true)&1n,1n);
// Until CPU injection is owned, an eligible PIC request with IF=1 must stop
// before the next instruction, not silently lose the event. IF=0 device
// tests above/below do not claim to have handled an interrupt.
vm.__indirect_function_table.set(slot,await compile([0xe4,0x70]));
data.fill(0,code,code+4096); data.set([0xe4,0x70],code); put(base+384,entry); put(base+392,0x10202);
view.setUint32(rows+8,2,true); assert.equal(vm.vm_bind_execution(rows,1,9n),0);
const interruptBefore=Buffer.from(data.subarray(base,base+1256));
assert.equal(vm.vm_run(port,9n,1),6n,'unowned eligible IRQ must not be silently ignored');
assert(data.subarray(base,base+1256).equals(interruptBefore)); assert.equal(vm.vm_completed(),0);
assert.equal(vm.vm_source_retired(),0n);
view.setUint32(segments+4,1,true);
assert.equal(vm.vm_run(port,9n,1),1n,'MOV-SS shadow still admits its one inhibited successor');
const shadowExpected=Buffer.from(interruptBefore);
shadowExpected.writeBigUInt64LE(entry+2n,384); shadowExpected.writeBigUInt64LE(shadowExpected.readBigUInt64LE(1128)+1n,1128);
shadowExpected.writeBigUInt64LE(shadowExpected.readBigUInt64LE(392)&~0x10000n,392);
shadowExpected.writeBigUInt64LE((shadowExpected.readBigUInt64LE(0)&~255n)|255n,0);
assert(data.subarray(base,base+1256).equals(shadowExpected)); assert.equal(view.getUint32(segments+4,true),0);
put(base+384,entry); assert.equal(vm.vm_run(port,9n,1),6n,'the pending PIC event survives the shadow');
assert.equal(vm.vm_io(port,0x21,0x101,255n),0n);
const maskedExpected=Buffer.from(data.subarray(base,base+1256));
assert.equal(vm.vm_run(port,9n,1),1n,'a masked PIC request must not falsely stop execution');
maskedExpected.writeBigUInt64LE(entry+2n,384);
maskedExpected.writeBigUInt64LE(maskedExpected.readBigUInt64LE(1128)+1n,1128);
maskedExpected.writeBigUInt64LE((maskedExpected.readBigUInt64LE(0)&~255n)|255n,0);
assert(data.subarray(base,base+1256).equals(maskedExpected));
assert.equal(vm.vm_io(port,0x21,0x101,0n),0n); put(base+384,entry);
assert.equal(vm.vm_run(port,9n,1),6n,'mask/unmask does not consume the pending PIC request');
await select(11); await run(0x71,true,1,0x92,0,1002000000n); await run(0x71,false,1,0,0x82,2000000000n);
await select(0); await run(0x71,false,1,0,0x57,2000000000n);
await run(0x71,true,1,0x15,0,2000000000n); await select(11); await run(0x71,true,1,2,0,2000000000n);
await select(0); await run(0x71,false,1,0,0x15,2000000000n);
reset(false); await run(0x71,false,1,0,0,0n,{refuse:true});
await select(0); assert.equal(vm.vm_rtc_start(port,9n,0n),-1,'seed after first index access is refused');
reset(); await select(7); await run(0x71,true,1,0x32,0,0n,{refuse:true});
reset(); await select(11); await run(0x71,true,1,1,0,0n,{refuse:true});
reset(); await select(11); await run(0x71,true,1,0x42); await select(0);
vm.__indirect_function_table.set(slot,await compile([0xe4,0x71]));
data.fill(0,code,code+4096); data.set([0xe4,0x71],code); put(base+384,entry); put(base+392,0x10202);
view.setUint32(rows+8,2,true); assert.equal(vm.vm_bind_execution(rows,1,9n),0);
const continuationExpected=Buffer.from(data.subarray(base,base+1256));
assert.equal(vm.vm_run(port,9n,1),18n);
assert(data.subarray(base,base+1256).equals(continuationExpected));
assert.equal(vm.vm_clock_commit(port,9n,view.getBigUint64(port+32,true),1000000n),0);
assert.equal(vm.vm_run(port,9n,1),1n,'IRQ arriving inside the sampled instruction cannot abort its continuation');
continuationExpected.writeBigUInt64LE(entry+2n,384);
continuationExpected.writeBigUInt64LE(continuationExpected.readBigUInt64LE(1128)+1n,1128);
continuationExpected.writeBigUInt64LE(continuationExpected.readBigUInt64LE(392)&~0x10000n,392);
continuationExpected.writeBigUInt64LE((continuationExpected.readBigUInt64LE(0)&~255n)|0x56n,0);
assert(data.subarray(base,base+1256).equals(continuationExpected));
put(base+384,entry); assert.equal(vm.vm_run(port,9n,1),6n,'unowned IRQ stops only at the next instruction boundary');
reset(); await select(0); vm.vm_close(); reset(); await select(0); await run(0x71,false,1,0,0x56);
reset(); await select(0); assert.equal(vm.vm_io(port,0x71,1,0n),18n);
const revokedTicket=view.getBigUint64(port+32,true); vm.vm_close(); reset();
assert.equal(vm.vm_clock_commit(port,9n,revokedTicket,0n),-1,'close revokes an outstanding clock reply');
assert.equal(vm.vm_io(port,0x71,1,0n),18n);
const freshTicket=view.getBigUint64(port+32,true); assert(freshTicket>revokedTicket);
assert.equal(vm.vm_clock_commit(port,9n,revokedTicket,0n),-1,'same-generation reopen cannot reuse a ticket');
assert.equal(vm.vm_clock_commit(port,9n,freshTicket,0n),0);
assert.equal(vm.vm_io(port,0x71,1,0n),0n); assert.equal(view.getBigUint64(port+8,true),0x56n);
assert.equal(vm.vm_clock_commit(port,9n,freshTicket,0n),0);
reset(); await select(0); assert.equal(vm.vm_io(port,0x71,1,0n),18n);
const staleTicket=view.getBigUint64(port+32,true); put(port,8);
assert.equal(vm.vm_clock_commit(port,9n,staleTicket,0n),-1,'stale record cannot advance RTC'); put(port,9);
assert.equal(vm.vm_clock_commit(port,9n,staleTicket,0n),0);
assert.equal(vm.vm_io(port,0x71,1,0n),0n); assert.equal(view.getBigUint64(port+8,true),0x56n);
vm.__indirect_function_table.set(slot,null); cc.compiler_close(); vm.vm_close();
console.log(JSON.stringify({format:'compiled-rtc-c-provider-v1',status:'pass',modules:cuts.size,comparisons,faults,
  waits,refusals,replays,irqBoundaryRefusals:4,shadowSuccessors:1,maskedSuccessors:1,inFlightIrqResumes:1,
  linuxBoot:'not-tested',irq:'C IRQ8/PIC latch and unowned-event refusal verified; CPU injection not tested',
  oracle:'full CPU/segment observations; dynamic C model and independent QEMU registers are separate tests'},null,2));
