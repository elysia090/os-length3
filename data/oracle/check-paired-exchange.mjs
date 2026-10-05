// Native observations compared with the actual C MMU/reservation/dispatcher.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {seedDisabledDebug} from './machine-observation.mjs';
const [providerFile,compilerFile,directory,elfDirectory]=process.argv.slice(2);
if (!directory) throw new Error('usage: check-paired-exchange.mjs VM.WASM COMPILER.WASM RECORD-DIRECTORY');
const memory=new WebAssembly.Memory({initial:8}), data=Buffer.from(memory.buffer), view=new DataView(memory.buffer);
const vm=(await WebAssembly.instantiate(await readFile(providerFile),{machine:{memory}})).instance.exports;
const cm=new WebAssembly.Memory({initial:16}), cold=Buffer.from(cm.buffer), cv=new DataView(cm.buffer);
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const input=cc.compiler_arena_min(), output=input+8192, report=output+65536;
const directoryAt=vm.vm_arena_min(), rows=directoryAt+512, base=directoryAt+4096, port=base+2048;
const firstPage=base+28672, nextPage=base+40960, codePage=base+57344, extraTables=base+65536;
const arenaBytes=81920, entry=0x400000n, stride=45*8, slot=vm.__indirect_function_table.grow(1);
const put=(at,value)=>view.setBigUint64(at,BigInt(value),true);
const word=(record,rank)=>record.readBigUInt64LE(rank*8);
const arena=()=>data.subarray(base,base+arenaBytes);
let parity=0,elfParity=0,comparisons=0,pageFaults=0,alignmentFaults=0,dispatchComparisons=0,rfChecks=0,waits=0,retries=0,refusals=0,reservations=0;
function page(rank,address,offset,kind=1) {
  const at=directoryAt+rank*32; put(at,address); view.setUint32(at+8,offset,true);
  view.setUint32(at+12,3,true); view.setUint32(at+16,kind,true); data.fill(0,at+20,at+32);
}
function open(meta) {
  assert.equal(vm.vm_open(base,arenaBytes,4096,directoryAt,10,10,directoryAt+1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0);
  put(rows,entry); view.setUint32(rows+8,meta.sourceBytes,true); view.setUint32(rows+12,1,true);
  view.setUint32(rows+16,slot,true); view.setUint32(rows+20,0,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
}
function setup(source,meta,record) {
  arena().fill(0);
  for (const [first,end] of [[128,384],[432,488],[496,1128],[1136,1256]]) data.fill(0x5a,base+first,base+end);
  seedDisabledDebug(view,base);
  for (let reg=0;reg<16;++reg) put(base+reg*8,word(record,reg));
  put(base+392,word(record,16)); put(base+384,entry); put(base+1128,42);
  put(base+400,0x80010001); put(base+408,0x1000); put(base+416,32); put(base+424,0xd00);
  put(base+432+7*8,0x13); put(port,9); put(port+8,0xabcd); put(port+16,1234);
  view.setUint32(port+24,13,true); view.setUint32(port+28,99,true); put(port+48,0xdeadbeef);
  for (let rank=0;rank<4;++rank) page(rank,BigInt((rank+1)*4096),(rank+2)*4096);
  page(4,0x8000n,firstPage-base); page(5,0x9000n,nextPage-base); page(6,0x10000n,codePage-base);
  for (let rank=0;rank<3;++rank) page(7+rank,BigInt(0x11000+rank*4096),extraTables+rank*4096-base);
  const address=word(record,35), shifts=[39n,30n,21n,12n];
  for (let level=0;level<4;++level)
    put(base+(level+2)*4096+Number(address>>shifts[level]&511n)*8,
      BigInt(level===3 ? 0x8000 : (level+2)*4096)|103n);
  const leaf=base+20480+Number(address>>12n&511n)*8;
  assert(Number(address>>12n&511n)<511); put(leaf+8,0x9067);
  function resident(physical) {
    for (let rank=0;rank<10;++rank) if (view.getBigUint64(directoryAt+rank*32,true)===physical)
      return base+view.getUint32(directoryAt+rank*32+8,true);
    assert.fail('table owner must be resident');
  }
  let table=base+8192,allocated=0;
  for (const shift of shifts) {
    const at=table+Number(entry>>shift&511n)*8; let pte=view.getBigUint64(at,true);
    if (shift===12n) { assert.equal(pte,0n); put(at,0x10067); data.set(source,codePage); }
    else { if (!(pte&1n)) { assert(allocated<3); pte=BigInt(0x11000+allocated++*4096)|103n; put(at,pte); }
      table=resident(pte&0x000ffffffffff000n); }
  }
  function store(expected,lo,hi) {
    for (let i=0;i<meta.bytes;++i) {
      const offset=Number(address&4095n)+i, at=offset<4096 ? firstPage+offset : nextPage+offset-4096;
      expected[at-base]=Number((i<8 ? lo : hi)>>BigInt((i%8)*8)&255n);
    }
  }
  store(arena(),word(record,36),word(record,37)); open(meta);
  return {address,leaf,store,split:Number(address&4095n)+meta.bytes>4096};
}
function expectedNative(initial,record,meta,info) {
  const expected=Buffer.from(initial), fault=word(record,40);
  for (let reg=0;reg<16;++reg) expected.writeBigUInt64LE(word(record,17+reg),reg*8);
  expected.writeBigUInt64LE(fault ? word(record,16) : word(record,33),392);
  expected.writeBigUInt64LE(word(record,34),384); expected.writeBigUInt64LE(fault ? 42n : 43n,1128);
  if (fault) {
    expected.writeBigUInt64LE(fault===14n ? word(record,42) : info.address,port-base+16);
    expected.writeUInt32LE(Number(fault),port-base+24); expected.writeUInt32LE(Number(word(record,41)),port-base+28);
  } else {
    expected.writeBigUInt64LE(word(record,36),port-base+8);
    if (meta.bytes===16) expected.writeBigUInt64LE(word(record,37),port-base+48);
    info.store(expected,word(record,38),word(record,39));
  }
  return expected;
}
function compare(cut,meta,expected,result,label,dispatch=false) {
  if (dispatch && result!==1n) { expected=Buffer.from(expected); expected.writeBigUInt64LE(BigInt(meta.fetchByte),port-base+8); }
  // Successful writes retire once, then revoke the next execution admission.
  // A stale dispatcher result here is not an unretired source instruction.
  assert.equal(dispatch ? vm.vm_run(port,9n,1) : cut(base,port,entry),dispatch && result===1n ? 5n : result,label);
  if (!arena().equals(expected)) {
    const differences=[];
    for (let i=0;i<arenaBytes && differences.length<16;++i) if (arena()[i]!==expected[i]) differences.push([i,arena()[i],expected[i]]);
    assert.fail(`${label}: entire CPU, payload, tables and port; differences=${JSON.stringify(differences)}`);
  }
  if (dispatch) { assert.equal(vm.vm_completed(),result===1n ? 1 : 0); assert.equal(vm.vm_source_retired(),result===1n ? 1n : 0n); ++dispatchComparisons; }
}
try {
  const forms=(await readdir(directory)).filter(name=>/^paired-exchange-\d+\.json$/.test(name))
    .map(name=>Number(name.slice(16,-5))).sort((a,b)=>a-b);
  assert.deepEqual(forms,Array.from({length:72},(_,rank)=>rank));
  for (const form of forms) {
    const prefix=path.join(directory,`paired-exchange-${form}`),meta=JSON.parse(await readFile(`${prefix}.json`));
    const source=await readFile(`${prefix}.source-page`),emitted=await readFile(`${prefix}.wasm`);
    meta.fetchByte=source[0];
    const native=await readFile(`${prefix}.cases`),faults=await readFile(`${prefix}.faults`);
    assert.equal(native.length,256*stride); assert.equal(faults.length,256*stride);
    cold.set(source,input); assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
    assert.equal(cv.getBigUint64(report+40,true),BigInt(emitted.length));
    assert(cold.subarray(output,output+emitted.length).equals(emitted)); ++parity;
    if (elfDirectory) {
      const elf=await readFile(path.join(elfDirectory,`paired-exchange-${form}.optimized.elf`));
      assert(elf.length<=output-input); cold.set(elf,input);
      assert.equal(cc.compiler_open_elf(input,elf.length),0);
      assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
      assert.equal(cv.getBigUint64(report+40,true),BigInt(emitted.length));
      assert(cold.subarray(output,output+emitted.length).equals(emitted)); ++elfParity;
    }
    const module=await WebAssembly.compile(emitted);
    assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'},
      {module:'machine',name:meta.bytes===16 ? 'reserve_pair' : 'reserve',kind:'function'},
      {module:'machine',name:meta.bytes===16 ? 'commit_pair' : 'commit',kind:'function'}]);
    const cut=(await WebAssembly.instantiate(module,{machine:{memory,reserve:vm.vm_reserve,commit:vm.vm_commit,
      reserve_pair:vm.vm_reserve_pair,commit_pair:vm.vm_commit_pair}})).exports.cut;
    vm.__indirect_function_table.set(slot,cut);
    for (let row=0;row<256;++row) {
      const record=native.subarray(row*stride,(row+1)*stride),pf=faults.subarray(row*stride,(row+1)*stride);
      const info=setup(source,meta,record),initial=Buffer.from(arena()),expected=expectedNative(initial,record,meta,info);
      const result=word(record,40)*8n+(word(record,40) ? 3n : 1n),label=`${form}/${row}`;
      compare(cut,meta,expected,result,`${label}: native/direct`); ++comparisons;
      if (word(record,40)) ++alignmentFaults;
      arena().set(initial); open(meta); compare(cut,meta,expected,result,`${label}: native/C-dispatch`,true);
      for (const dispatch of [false,true]) {
        arena().set(initial); put(base+392,word(record,16)|0x10000n); open(meta);
        const rf=Buffer.from(expected); if (result!==1n) rf.writeBigUInt64LE(word(record,16)|0x10000n,392);
        compare(cut,meta,rf,result,`${label}: RF ${dispatch}`,dispatch); ++rfChecks;
      }
      arena().set(initial); put(info.leaf+(info.split ? 8 : 0),word(pf,44) ? (info.split ? 0x9065 : 0x8065) : 0); open(meta);
      const blocked=Buffer.from(arena()),expectedPF=expectedNative(blocked,pf,meta,info);
      const pfResult=word(pf,40)*8n+3n;
      compare(cut,meta,expectedPF,pfResult,`${label}: native write #PF`); ++pageFaults;
      arena().set(blocked); open(meta); compare(cut,meta,expectedPF,pfResult,`${label}: C-dispatch #PF`,true);
      if (row<8 && !word(record,40)) for (const dispatch of [false,true]) {
        arena().set(initial);
        const rank=info.split ? 5 : 4,physical=info.split ? 0x9000n : 0x8000n,offset=Number(info.address&4095n);
        page(rank,physical,0,3); open(meta);
        const pending=Buffer.from(initial);
        pending.writeBigUInt64LE(physical+BigInt(info.split ? 0 : offset),port-base+32);
        pending.writeUInt32LE(info.split ? meta.bytes-(4096-offset) : meta.bytes,port-base+40);
        pending.writeUInt32LE(19,port-base+44);
        compare(cut,meta,pending,2n,`${label}: residency ${dispatch}`,dispatch); ++waits;
        page(rank,physical,(rank===5 ? nextPage : firstPage)-base); open(meta);
        const resumed=Buffer.from(expected); pending.copy(resumed,port-base+32,port-base+32,port-base+48);
        compare(cut,meta,resumed,result,`${label}: retry ${dispatch}`,dispatch); ++retries;
      }
    }
    const record=native.subarray(0,stride);
    for (const failure of ['TF','AC','alias','unaligned','bounds','wrong-rip','stale','closed']) {
      setup(source,meta,record);
      if (failure==='TF') put(base+392,word(record,16)|256n);
      if (failure==='AC') put(base+392,word(record,16)|0x40000n);
      if (failure==='wrong-rip') put(base+384,entry+1n);
      if (failure==='stale') put(port,8);
      if (failure==='closed') vm.vm_close();
      const before=Buffer.from(arena());
      assert.equal(cut(base,failure==='alias' ? base : failure==='unaligned' ? port+1 : failure==='bounds' ? 0xfffffff8 : port,entry),failure==='stale' ? 5n : 6n);
      assert(arena().equals(before)); ++refusals;
    }
    if (meta.bytes===16) for (const failure of ['abort','stale','wrong-port','scalar-commit','another-access','close']) {
      const info=setup(source,meta,record); assert.equal(vm.vm_reserve_pair(port,info.address,16,meta.access),0n);
      if (failure==='abort') vm.vm_abort();
      if (failure==='stale') put(port,8);
      if (failure==='another-access') assert.equal(vm.vm_access(port,info.address,8,1,0n),0n);
      if (failure==='close') vm.vm_close();
      const before=Buffer.from(arena());
      const status=failure==='scalar-commit' ? vm.vm_commit(port,1n) : vm.vm_commit_pair(failure==='wrong-port' ? port+64 : port,1n,2n);
      assert.equal(status,failure==='stale' ? 5n : failure==='wrong-port' ? 5n : 6n);
      assert(arena().equals(before)); put(port,9); assert.equal(vm.vm_commit_pair(port,1n,2n),6n); ++reservations;
    }
  }
} finally { vm.__indirect_function_table.set(slot,null); vm.vm_close(); cc.compiler_close(); }
console.log(JSON.stringify({format:'c-wasm-paired-exchange-native-v1',status:'pass',parity,elfParity,comparisons,pageFaults,alignmentFaults,
  dispatchComparisons,rfChecks,waits,retries,refusals,reservations,
  oracle:'actual x86 user-mode execution in reference build VM; accelerator provenance recorded separately, not physical hardware',linuxBoot:'not-tested',smp:'not-tested'},null,2));
