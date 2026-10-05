// Generated interrupt/clock boundaries; model and independent oracle scopes
// are reported separately. Passing these checks is not Linux boot.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {CutProgress} from '../../src/v2/vm/check/browser/cut-progress.mjs';
const [vmFile,compilerFile,systemRows]=process.argv.slice(2);
if(!compilerFile)throw new Error('usage: check-interrupt-provider.mjs VM.WASM COMPILER.WASM [SYSTEM-ROWS.txt]');
const cm=new WebAssembly.Memory({initial:16});
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const input=cc.compiler_arena_min(),output=input+8192,report=output+65536;
const bytes=new Uint8Array(cm.buffer),view=new DataView(cm.buffer);
bytes.fill(0x90,input,input+4096);bytes[input]=0xfb;
assert.equal(cc.compiler_open_pages(input,1,0x9000n,9n),0);
assert.equal(cc.compiler_emit(0x9000n,1,output,65536,report),0,'STI must compile through the common boundary');
const memory=new WebAssembly.Memory({initial:8});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
assert.equal(typeof vm.vm_clock_poll,'function','clock progress must not require a guest time instruction');
const data=Buffer.from(memory.buffer),v=new DataView(memory.buffer),dir=vm.vm_arena_min();
const base=dir+4096,segments=base+1408,port=base+2048,rows=dir+512;
const addresses=[0x1000,0x2000,0x3000,0x4000,0x5000,0x8000,0x9000,0xa000,0xb000];
const payload=i=>base+(i+2)*4096;
const put=(at,value)=>v.setBigUint64(at,BigInt(value),true),get=at=>v.getBigUint64(at,true);
const slot=vm.__indirect_function_table.grow(1),cuts=new Map();let now=0n;
function reset(){
  data.fill(0,base);
  now=0n;
  addresses.forEach((a,i)=>{
    put(dir+i*32,a);v.setUint32(dir+i*32+8,(i+2)*4096,true);
    v.setUint32(dir+i*32+12,3,true);v.setUint32(dir+i*32+16,1,true);data.fill(0,dir+i*32+20,dir+i*32+32);
  });
  put(payload(0),0x2027);put(payload(1),0x3027);put(payload(2),0xe7);
  put(payload(3)+8,0x00af9b000000ffffn);put(payload(3)+16,0x00cf93000000ffffn);
  for(let i=0;i<16;++i)put(base+i*8,0xabcdef8765430000n+BigInt(i));
  put(base+32,0xaf00);put(base+384,0x9000);put(base+392,0x10002);
  put(base+400,0x80010011);put(base+408,0x1000);put(base+416,32);put(base+424,0x500);
  put(base+432,0xabcdef);put(base+448,0x4000);put(base+456,23);put(base+464,0x5000);
  put(base+472,4095);put(base+488,8);put(base+496,16);put(base+1128,123);
  v.setUint32(segments,2,true);v.setUint32(segments+36,0xa09b,true);v.setUint32(segments+52,0xc093,true);
  put(port,9);
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,addresses.length,addresses.length,dir+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
}
async function compile(opcode){
  const key=opcode.join(',');if(cuts.has(key))return cuts.get(key);
  bytes.fill(0x90,input,input+4096);bytes.set(opcode,input);
  assert.equal(cc.compiler_open_pages(input,1,0x9000n,9n),0);
  assert.equal(cc.compiler_emit(0x9000n,1,output,65536,report),0);
  const module=await WebAssembly.compile(bytes.slice(output,output+Number(view.getBigUint64(report+40,true))));
  const cut=(await WebAssembly.instantiate(module,{machine:{memory,interrupt_flag:vm.vm_flag,iret:vm.vm_iret,
    segment:vm.vm_segment,io:vm.vm_io}})).exports.cut;
  cuts.set(key,cut);return cut;
}
async function bind(opcode){
  data.set(opcode,payload(6));put(base+384,0x9000);
  vm.__indirect_function_table.set(slot,await compile(opcode));
  put(rows,0x9000);v.setUint32(rows+8,opcode.length,true);v.setUint32(rows+12,1,true);
  v.setUint32(rows+16,slot,true);v.setUint32(rows+20,0,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
let transfers=0,privilegeFaults=0,irqEntries=0,waits=0,refusals=0;
for(const enable of [0,1])for(let cpl=0;cpl<4;++cpl)for(let iopl=0;iopl<4;++iopl)
for(const previousIF of [0,1])for(let shadow=0;shadow<3;++shadow)for(const arithmetic of [0,1,0x44,0x880]){
  reset();put(base+488,8|cpl);v.setUint32(segments+36,0xa09b|(cpl<<5),true);
  const flags=0x10002|arithmetic|(iopl<<12)|(previousIF<<9);put(base+392,flags);v.setUint32(segments+4,shadow,true);
  await bind([enable?0xfb:0xfa]);
  const expected=Buffer.from(data.subarray(base,base+1256)),hidden=Buffer.from(data.subarray(segments,segments+136));
  const result=vm.vm_run(port,9n,1);
  if(cpl>iopl){
    assert.equal(result,107n);assert.equal(get(port+16),0x9000n);assert.equal(v.getUint32(port+24,true),13);
    assert.equal(v.getUint32(port+28,true),0);++privilegeFaults;
  }else{
    assert.equal(result,1n);expected.writeBigUInt64LE(0x9001n,384);expected.writeBigUInt64LE(124n,1128);
    expected.writeBigUInt64LE(BigInt((enable?flags|0x200:flags&~0x200)&~0x10000),392);
    hidden.writeUInt32LE(enable&&!previousIF&&!shadow?2:0,4);
  }
  assert(data.subarray(base,base+1256).equals(expected));assert(data.subarray(segments,segments+136).equals(hidden));
  assert.equal(vm.vm_completed(),cpl>iopl?0:1);++transfers;
}
// Sampled RTC is the real C IRQ8 source, not a host CPU injection callback.
function io(coordinate,write,value){
  let result=vm.vm_io(port,coordinate,1|(write<<8),BigInt(value));
  if(result===18n){assert.equal(vm.vm_clock_commit(port,9n,get(port+32),now),0);result=vm.vm_io(port,coordinate,1|(write<<8),BigInt(value));}
  assert.equal(result,0n);
}
function pending(vector=40){
  for(const [p,x] of [[0x20,0x11],[0xa0,0x11],[0x21,32],[0xa1,vector],[0x21,4],[0xa1,2],
    [0x21,1],[0xa1,1],[0x21,0xfb],[0xa1,0xfe]])io(p,1,x);
  assert.equal(vm.vm_rtc_start(port,9n,1791117296n),0);
  io(0x70,1,11);io(0x71,1,0x42);
  assert.equal(vm.vm_time(port),18n);assert.equal(vm.vm_clock_commit(port,9n,get(port+32),10000000n),0);
  now=10000000n;
  assert.equal(vm.vm_time(port),0n);
}
function gate(vector,type=0x8e){put(payload(4)+vector*16,0x8000n|8n<<16n|BigInt(type)<<40n);}
function pitProgram(){
  for(const [p,x]of [[0x20,0x11],[0xa0,0x11],[0x21,32],[0xa1,40],[0x21,4],[0xa1,2],
    [0x21,1],[0xa1,1],[0x21,0xfe],[0xa1,0xff],[0x43,0x34],[0x40,4],[0x40,0]])io(p,1,x);
  // Intel mode 2 starts OUT high. Acknowledge that initial edge, then wait
  // through real elapsed periods. The clock reply, not a host IRQ injection,
  // must produce the next pending edge even when final OUT is again high.
  io(0x20,1,0x0c);io(0x20,0,0);assert.equal(get(port+8),128n);
  io(0x20,1,0x20);
}
function pitPending(){
  pitProgram();
  assert.equal(vm.vm_time(port),18n);now=34362n; // 41 PIT pulses, ten complete periods.
  assert.equal(vm.vm_clock_commit(port,9n,get(port+32),now),0);assert.equal(vm.vm_time(port),0n);
}
let pitIrqEntries=0,pitBoundaryEntries=0,pureLoopCuts=0;
for(const boundaryClock of [false,true])for(const type of [0x8e,0x8f])for(let align=0;align<16;++align){
  reset();if(boundaryClock)pitProgram();else pitPending();
  gate(32,type);put(base+32,0xaf00-align);put(base+392,boundaryClock?0x603:0x10603);
  await bind(boundaryClock?[0xeb,0xfe]:[0x90]);
  if(boundaryClock){
    // A compiled pure self-loop never reads time and cannot update PIT by
    // itself. The supervisor event alone must make a new IRQ eligible.
    for(let iteration=0;iteration<100;++iteration){
      assert.equal(vm.vm_run(port,9n,1),1n);assert.equal(vm.vm_completed(),1);
      assert.equal(get(base+384),0x9000n);++pureLoopCuts;
    }
    const cpu=Buffer.from(data.subarray(base,base+1256)),hidden=Buffer.from(data.subarray(segments,segments+136));
    assert.equal(vm.vm_clock_poll(port,8n),5n);assert.equal(vm.vm_clock_poll(port,9n),18n);
    const ticket=get(port+32);assert.equal(vm.vm_clock_poll(port,9n),18n);assert.equal(get(port+32),ticket);
    assert.equal(vm.vm_boundary(port,9n),6n);assert.equal(vm.vm_run(port,9n,1),6n);
    assert.equal(vm.vm_bind_execution(rows,1,9n),-1);
    put(base+384,0x9001);assert.equal(vm.vm_clock_commit(port,9n,ticket,34362n),-1);put(base+384,0x9000);
    assert.equal(vm.vm_clock_commit(port,8n,ticket,34362n),-1);
    assert.equal(vm.vm_clock_commit(port,9n,ticket+1n,34362n),-1);
    assert.equal(vm.vm_clock_commit(port,9n,ticket,34362n),0);
    assert.equal(vm.vm_clock_commit(port,9n,ticket,34362n),0);
    assert.equal(vm.vm_boundary(port,9n),6n);assert.equal(vm.vm_clock_poll(port,9n),0n);
    assert.equal(vm.vm_clock_commit(port,9n,ticket,34362n),0);
    assert(data.subarray(base,base+1256).equals(cpu));assert(data.subarray(segments,segments+136).equals(hidden));
  }
  const before=get(base+1128);assert.equal(vm.vm_run(port,9n,1),1n);
  assert.equal(vm.vm_completed(),0);assert.equal(vm.vm_source_retired(),0n);assert.equal(get(base+1128),before);
  assert.equal(get(base+384),0x8000n);assert.equal(get(base+392),BigInt(type===0x8e?0x403:0x603));
  const rsp=((0xaf00n-BigInt(align))&~15n)-40n,at=payload(7)+Number(rsp&4095n);
  assert.equal(get(base+32),rsp);
  for(const [i,value]of [0x9000n,8n,boundaryClock?0x603n:0x10603n,0xaf00n-BigInt(align),16n].entries())assert.equal(get(at+i*8),value);
  assert.equal(vm.vm_iret(port),0n);io(0x20,1,0x20);assert.equal(get(base+384),0x9000n);
  if(boundaryClock)++pitBoundaryEntries;else ++pitIrqEntries;
}
for(const vector of [0,8,40])for(const type of [0x8e,0x8f])for(let align=0;align<16;++align){
  reset();pending(vector);gate(vector,type);put(base+32,0xaf00-align);put(base+392,0x10603);
  await bind([0x90]);const beforeRetired=get(base+1128);
  assert.equal(vm.vm_run(port,9n,1),1n);assert.equal(vm.vm_completed(),0);assert.equal(vm.vm_source_retired(),0n);
  assert.equal(get(base+384),0x8000n);assert.equal(get(base+1128),beforeRetired);assert.equal(get(base+432),0xabcdefn);
  assert.equal(get(base+392),BigInt(type===0x8e?0x403:0x603));
  const rsp=((0xaf00n-BigInt(align))&~15n)-40n,at=payload(7)+Number(rsp&4095n);
  assert.equal(get(base+32),rsp);
  for(const [i,value]of [0x9000n,8n,0x10603n,0xaf00n-BigInt(align),16n].entries())assert.equal(get(at+i*8),value);
  assert.equal(vm.vm_iret(port),0n);assert.equal(get(base+392),0x10603n);assert.equal(get(base+384),0x9000n);
  ++irqEntries;
}
// STI's one successor is preserved across a real clock barrier. Its second
// STI cannot extend inhibition; a CLI successor instead keeps IF clear.
for(const second of [[0xfb],[0xfa],[0x90],[0x8e,0xd0],[0xe4,0x71]]){
  reset();pending();gate(40);await bind([0xfb]);assert.equal(vm.vm_run(port,9n,1),1n);
  assert.equal(v.getUint32(segments+4,true),2);put(base,16);
  if(second[0]===0xe4)io(0x70,1,0); // Running RTC read requires one new sampled clock.
  await bind(second);let result=vm.vm_run(port,9n,1);
  if(second[0]===0xe4){
    assert.equal(result,18n);assert.equal(v.getUint32(segments+4,true),2);assert.equal(vm.vm_completed(),0);
    const cpu=Buffer.from(data.subarray(base,base+1256));
    assert.equal(vm.vm_clock_poll(port,9n),6n);assert(data.subarray(base,base+1256).equals(cpu));
    assert.equal(vm.vm_clock_commit(port,9n,get(port+32),10000001n),0);
    result=vm.vm_run(port,9n,1);++waits;
  }
  assert(result===1n||result===5n);assert.equal(v.getUint32(segments+4,true),0);assert.equal(vm.vm_completed(),1);
  await bind([0x90]);const before=get(base+1128);result=vm.vm_run(port,9n,1);
  assert.equal(result,1n);assert.equal(vm.vm_completed(),second[0]===0xfa?1:0);
  assert.equal(get(base+1128),before+(second[0]===0xfa?1n:0n));
}
// No privilege/state/record rejection is allowed to acknowledge the PIC.
reset();pending();gate(40);put(base+392,0x202);put(base+488,11);await bind([0x90]);
assert.equal(vm.vm_run(port,9n,1),6n);put(base+488,8);assert.equal(vm.vm_run(port,8n,1),5n);
assert.equal(vm.vm_run(port,9n,0),6n);put(port,8);assert.equal(vm.vm_run(port,9n,1),5n);
put(port,9);assert.equal(vm.vm_run(port,9n,1),1n);assert.equal(vm.vm_completed(),0);refusals+=4;
// Invalid IDT gate produces #NP with EXT=1 and no instruction retirement.
reset();pending();gate(40,0x0e);put(base+392,0x202);await bind([0x90]);
assert.equal(vm.vm_run(port,9n,1),91n);assert.equal(v.getUint32(port+28,true),40*8+3);assert.equal(vm.vm_completed(),0);
// An eligible IRQ precedes a new source projection, even if that source
// would #PF. Supervisor admission cannot invent a fetch fault ahead of it.
reset();pending();gate(40);put(base+392,0x202);put(base+384,0x400000);
const codeView=port+64;
data.fill(0xa5,codeView,codeView+48);data.fill(0xa5,rows,rows+24);
assert.equal(vm.vm_source_query(port,0x400000n,8,codeView,rows),6n);
assert(data.subarray(codeView,codeView+48).every(x=>x===0xa5));
assert(data.subarray(rows,rows+24).every(x=>x===0xa5));
assert.equal(vm.vm_boundary(port,8n),5n);
assert.equal(vm.vm_boundary(port,9n),1n);assert.equal(vm.vm_completed(),0);
assert.equal(vm.vm_source_retired(),0n);assert.equal(get(base+384),0x8000n);
assert.equal(get(payload(7)+0xed8),0x400000n,'IRQ saves the unfetched source RIP');
assert.equal(vm.vm_boundary(port,9n),0n);
// A source-owned cohort retires STI and its inhibited successor in C. The
// successor jumps to an unmapped RIP: the now eligible IRQ MUST precede
// both cache selection and the otherwise faulting opcode fetch.
let ownedCohortIrqs=0;
for(const oldShadow of [0,1,2]){
  reset();v.setUint32(segments+4,oldShadow,true);
  const start=0x9000n,program=[0xfb,0xe9,0xfa,0x6f,0x3f,0];
  data.set(program,payload(6));
  const first=vm.vm_slot_min(),sourceCapacity=vm.vm_source_capacity();
  vm.__indirect_function_table.grow(Math.max(0,first+sourceCapacity-vm.__indirect_function_table.length));
  for(const [offset,length]of [[0,1],[1,5]]){
    const at=start+BigInt(offset);
    assert.equal(vm.vm_source_query(port,at,1,codeView,rows),1n);
    const ownedSlot=v.getUint32(rows+16,true),borrowed=v.getUint32(codeView+16,true);
    bytes.set(data.subarray(borrowed,borrowed+4096),input);
    assert.equal(cc.compiler_open_pages(input,1,start,9n),0);
    assert.equal(cc.compiler_emit(at,1,output,65536,report),0);
    assert.equal(view.getBigUint64(report+32,true),BigInt(length));
    const cut=(await WebAssembly.instantiate(bytes.slice(output,output+Number(view.getBigUint64(report+40,true))),
      {machine:{memory,interrupt_flag:vm.vm_flag}})).instance.exports.cut;
    vm.__indirect_function_table.set(ownedSlot,cut);assert.equal(vm.vm_source_publish(length,1,rows),0);
  }
  pending();gate(40);
  assert.equal(vm.vm_source_query(port,start,1,codeView,rows),0n);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  assert.equal(vm.vm_run(port,9n,99),1n);
  const done=oldShadow?1:2,savedRip=oldShadow?0x9001n:0x400000n;
  const progress=new CutProgress(123);
  progress.add(vm.vm_completed(),vm.vm_source_retired(),get(base+1128),99);
  assert.equal(progress.completed,done);assert.equal(progress.retired,done);
  assert.equal(vm.vm_source_admissions(),done);assert.equal(vm.vm_source_demands(),oldShadow?1n:3n);
  assert.equal(vm.vm_run_interrupted(),1,'IRQ observation includes a committed prefix, not retirement');
  assert.equal(vm.vm_completed(),done);assert.equal(vm.vm_source_retired(),BigInt(done));
  assert.equal(get(base+1128),123n+BigInt(done));assert.equal(get(base+384),0x8000n);
  assert.equal(get(base+392),2n);assert.equal(v.getUint32(segments+4,true),0);
  assert.equal(get(base+32),0xaed8n);
  for(const [index,value]of [savedRip,8n,0x202n,0xaf00n,16n].entries())
    assert.equal(get(payload(7)+0xed8+index*8),value);
  assert.notEqual(v.getUint32(port+24,true),14,'no opcode #PF ahead of the IRQ');
  for(let rank=0;rank<sourceCapacity;++rank)vm.__indirect_function_table.set(first+rank,null);
  ++ownedCohortIrqs;
}
// C clamps an inhibited source to one instruction, even if the supervisor
// requests a larger block. The source cache cannot bypass that constraint.
reset();v.setUint32(segments+4,2,true);data.set([0x90,0x90],payload(6));
assert.equal(vm.vm_source_query(port,0x9000n,8,codeView,rows),1n);
assert.equal(vm.vm_source_publish(2,2,rows),-1);
// ABI v1 used this same word for a different inhibition contract.
reset();v.setUint32(segments,1,true);assert.equal(vm.vm_bind_segments(segments),-1);
v.setUint32(segments,2,true);assert.equal(vm.vm_bind_segments(segments),0);
// Boundary-clock tickets are supervisor-owned and survive neither rebind nor
// reopen. Failed admission cannot overwrite the request or mutate the CPU.
reset();
const clockCPU=Buffer.from(data.subarray(base,base+1256));
assert.equal(vm.vm_clock_poll(base,9n),6n);
assert.equal(vm.vm_clock_poll(port+1,9n),6n);
assert.equal(vm.vm_clock_poll(port,8n),5n);
put(port,8);assert.equal(vm.vm_clock_poll(port,9n),5n);put(port,9);
assert.equal(vm.vm_clock_poll(port,9n),18n);
const cancelledClock=get(port+32);
data.fill(0xa5,codeView,codeView+48);data.fill(0xa5,rows,rows+24);
assert.equal(vm.vm_source_query(port,0x9000n,8,codeView,rows),6n);
assert(data.subarray(codeView,codeView+48).every(x=>x===0xa5));
assert(data.subarray(rows,rows+24).every(x=>x===0xa5));
assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
assert.equal(vm.vm_clock_commit(port,9n,cancelledClock,1n),-1);
assert.equal(vm.vm_clock_poll(port,9n),18n);
const acceptedClock=get(port+32);assert(acceptedClock>cancelledClock);
assert.equal(vm.vm_clock_commit(port,9n,acceptedClock,1n),0);
assert.equal(vm.vm_clock_poll(port,9n),0n);
assert.equal(vm.vm_clock_commit(port,9n,acceptedClock,1n),0);
assert(data.subarray(base,base+1256).equals(clockCPU));
assert.equal(vm.vm_bind_segments(segments),0);
assert.equal(vm.vm_clock_commit(port,9n,acceptedClock,1n),-1,'rebind revokes even an acknowledged clock ticket');
vm.vm_close();assert.equal(vm.vm_clock_commit(port,9n,acceptedClock,1n),-1);
reset();assert.equal(vm.vm_clock_poll(port,9n),18n);
assert(get(port+32)>acceptedClock,'same-generation reopen cannot reuse a ticket');
assert.equal(vm.vm_clock_commit(port,9n,acceptedClock,1n),-1);
assert.equal(vm.vm_clock_commit(port,9n,get(port+32),0n),0);
assert.equal(vm.vm_clock_poll(port,9n),0n);
reset();data.set([0x90],payload(6));
assert.equal(vm.vm_source_query(port,0x9000n,1,codeView,rows),1n);
const pinnedClockCPU=Buffer.from(data.subarray(base,base+1256)),pinnedRequest=Buffer.from(data.subarray(port,port+64));
assert.equal(vm.vm_clock_poll(port,9n),6n);
assert(data.subarray(base,base+1256).equals(pinnedClockCPU));
assert(data.subarray(port,port+64).equals(pinnedRequest));
let systemComparisons=0,qemuSavedRFDifferences=0;
if(systemRows){
  const records=(await readFile(systemRows,'utf8')).trim().split('\n').map(line=>line.trim().split(/\s+/).map(x=>BigInt(`0x${x}`)));
  assert.equal(records.length,192);
  for(const [index,row]of records.entries()){
    assert.equal(row.length,16);assert.equal(row[0],BigInt(index));assert.equal(row[15],1n,'exactly one hardware interrupt');
    assert.equal(row[5],row[14],'independent consecutive-inhibition sequence must interrupt at its expected boundary');
    reset();put(dir+7*32,row[1]&~4095n);put(dir+8*32,(row[1]&~4095n)+4096n);
    assert.equal(vm.vm_open(base,data.length-base,4096,dir,addresses.length,addresses.length,dir+1024,9n),0);
    assert.equal(vm.vm_bind_state(base),0);assert.equal(vm.vm_bind_segments(segments),0);
    const architecturalFlags=row[2]|0x200n;
    assert.equal(row[7]&~0x10000n,architecturalFlags);
    // QEMU's do_interrupt64 classifies hardware vector 32 as a fault for
    // set_rf. Intel SDM 19.3.1.1 preserves RF for an ordinary boundary IRQ.
    // Do not copy that oracle discrepancy into CPU input or product behavior.
    if(row[7]!==architecturalFlags)++qemuSavedRFDifferences;
    pending(32);gate(32,index<96?0x8e:0x8f);put(base+32,row[1]);put(base+384,row[5]);put(base+392,architecturalFlags);
    assert.equal(vm.vm_run(port,9n,1),1n);assert.equal(vm.vm_completed(),0);assert.equal(get(base+32),row[3]);
    assert.equal(get(base+392),row[4]);assert.equal(get(base+1128),123n);
    const stackAt=payload(7)+Number(row[3]&4095n);
    for(let i=0;i<5;++i)assert.equal(get(stackAt+i*8),i===2?row[7]&~0x10000n:row[5+i]);
    assert.equal(vm.vm_iret(port),0n);assert.equal(get(base+32),row[13]);assert.equal(get(base+392)&~0x200n,row[12]);
    ++systemComparisons;
  }
}
console.log(JSON.stringify({format:'interrupt-provider-v1',status:'pass',transfers,privilegeFaults,irqEntries,pitIrqEntries,pitBoundaryEntries,pureLoopCuts,waits,refusals,
  ownedCohortIrqs,
  clockLifecycle:'private port/generation/source pin/duplicate/cancel/rebind/reopen assertions green',
  admissionPriorityChecks:1,shadowExtentChecks:1,oldAbiRefusals:1,
  systemComparisons,qemuSavedRFDifferences,oracle:systemRows?'QEMU TCG PIT/PIC/shadow/IDT; saved RF difference explicitly excluded; privilege/RF matrix is a model':
    'architectural model only; supply SYSTEM-ROWS.txt for independent system comparison',linuxBoot:'not-tested'},null,2));
