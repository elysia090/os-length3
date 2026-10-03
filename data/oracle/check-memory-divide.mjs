// Actual x86 observations through C-Wasm loads/division/dispatch, not a guest interpreter.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
const [providerFile,compilerFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-memory-divide.mjs VM.WASM COMPILER.WASM RECORD-DIRECTORY');
const memory = new WebAssembly.Memory({initial:8}), data = Buffer.from(memory.buffer), view = new DataView(memory.buffer);
const vm = (await WebAssembly.instantiate(await readFile(providerFile),{machine:{memory}})).instance.exports;
const cm = new WebAssembly.Memory({initial:16}), cold = Buffer.from(cm.buffer), cv = new DataView(cm.buffer);
const cc = (await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:cm}})).instance.exports;
const input = cc.compiler_arena_min(), output = input+8192, report = output+65536;
const directoryAt = vm.vm_arena_min(), rows = directoryAt+512, base = directoryAt+4096, port = base+2048;
const firstPage = base+28672, nextPage = base+40960, codePage = base+57344, extraTables = base+65536;
const arenaBytes = 81920, entry = 0x400000n, stride = 40*8, slot = vm.__indirect_function_table.grow(1);
const put = (at,value) => view.setBigUint64(at,BigInt(value),true);
const word = (record,rank) => record.readBigUInt64LE(rank*8);
const arena = () => data.subarray(base,base+arenaBytes);
let parity=0, comparisons=0, successes=0, divideFaults=0, pageFaults=0, dispatchComparisons=0;
let rfChecks=0, waits=0, retries=0, refusals=0, addressFaultModels=0;
function page(rank,address,offset,kind=1) {
  const at = directoryAt+rank*32; put(at,address); view.setUint32(at+8,offset,true);
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
  for (let reg=0;reg<16;++reg) put(base+reg*8,word(record,reg));
  put(base+392,word(record,16)); put(base+384,entry); put(base+1128,42);
  put(base+400,0x80010001); put(base+408,0x1000); put(base+416,32); put(base+424,0xd00);
  put(base+432+7*8,0x13); put(port,9); put(port+16,1234);
  view.setUint32(port+24,13,true); view.setUint32(port+28,99,true);
  for (let rank=0;rank<4;++rank) page(rank,BigInt((rank+1)*4096),(rank+2)*4096);
  page(4,0x8000n,firstPage-base); page(5,0x9000n,nextPage-base);
  page(6,0x10000n,codePage-base);
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
    assert.fail('test table owner must be resident');
  }
  let table=base+8192, allocated=0;
  for (const shift of shifts) {
    const at=table+Number(entry>>shift&511n)*8; let pte=view.getBigUint64(at,true);
    if (shift===12n) {
      assert.equal(pte,0n,'source and operand are distinct pages in these native records');
      put(at,0x10067); data.set(source,codePage);
    } else {
      if (!(pte&1n)) { assert(allocated<3); pte=BigInt(0x11000+allocated++*4096)|103n; put(at,pte); }
      table=resident(pte&0x000ffffffffff000n);
    }
  }
  const bytes=meta.width/8;
  for (let i=0;i<8;++i) {
    const offset=Number(address&4095n)+i, at=offset<4096 ? firstPage+offset : nextPage+offset-4096;
    data[at]=Number(word(record,36)>>BigInt(i*8)&255n);
  }
  open(meta);
  return {address,leaf,bytes,split:Number(address&4095n)+bytes>4096};
}
function expectNative(initial,record,meta) {
  const expected=Buffer.from(initial), fault=!!word(record,37);
  for (let reg=0;reg<16;++reg) expected.writeBigUInt64LE(word(record,17+reg),reg*8);
  expected.writeBigUInt64LE(word(record,33),392); expected.writeBigUInt64LE(word(record,34),384);
  expected.writeBigUInt64LE(fault ? 42n : 43n,1128);
  expected.writeBigUInt64LE(word(record,36)&((1n<<BigInt(meta.width))-1n),port-base+8);
  if (fault) {
    expected.writeBigUInt64LE(entry,port-base+16); expected.writeUInt32LE(0,port-base+24); expected.writeUInt32LE(0,port-base+28);
  }
  return expected;
}
function compare(cut,meta,expected,result,label,dispatch=false) {
  // vm_run validates execute permission with a one-byte C fetch before calling
  // the cut. A failed/pending operand read retains that scratch port value;
  // it does not publish any guest CPU register or part of the divisor.
  if (dispatch && (result===2n || ((result&7n)===3n && result!==3n))) {
    expected=Buffer.from(expected);
    expected.writeBigUInt64LE(BigInt(meta.fetchByte),port-base+8);
  }
  assert.equal(dispatch ? vm.vm_run(port,9n,1) : cut(base,port),result,label);
  if (!arena().equals(expected)) {
    const differences=[];
    for (let i=0;i<arenaBytes && differences.length<16;++i)
      if (arena()[i]!==expected[i]) differences.push([i,arena()[i],expected[i]]);
    assert.fail(`${label}: entire CPU, payload, tables and port; differences=${JSON.stringify(differences)}`);
  }
  if (dispatch) {
    assert.equal(vm.vm_completed(),result===1n ? 1 : 0); assert.equal(vm.vm_source_retired(),result===1n ? 1n : 0n);
    ++dispatchComparisons;
  }
}
try {
  const forms=(await readdir(directory)).filter(name=>/^memory-divide-\d+\.json$/.test(name))
    .map(name=>Number(name.slice(14,-5))).sort((a,b)=>a-b);
  assert.deepEqual(forms,Array.from({length:72},(_,rank)=>rank));
  for (const form of forms) {
    const prefix=path.join(directory,`memory-divide-${form}`), meta=JSON.parse(await readFile(`${prefix}.json`));
    const source=await readFile(`${prefix}.source-page`), emitted=await readFile(`${prefix}.wasm`);
    meta.fetchByte=source[0];
    const native=await readFile(`${prefix}.cases`), faults=await readFile(`${prefix}.faults`);
    assert.equal(native.length,512*stride); assert.equal(faults.length,512*stride);
    cold.set(source,input); assert.equal(cc.compiler_open_pages(input,1,entry,9n),0);
    assert.equal(cc.compiler_emit(entry,1,output,65536,report),0);
    assert.equal(cv.getBigUint64(report+40,true),BigInt(emitted.length));
    assert(cold.subarray(output,output+emitted.length).equals(emitted)); ++parity;
    const module=await WebAssembly.compile(emitted);
    assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'},
      {module:'machine',name:'access',kind:'function'}]);
    const cut=(await WebAssembly.instantiate(module,{machine:{memory,access:vm.vm_access}})).exports.cut;
    vm.__indirect_function_table.set(slot,cut);
    for (let row=0;row<512;++row) {
      const record=native.subarray(row*stride,(row+1)*stride), pf=faults.subarray(row*stride,(row+1)*stride);
      const info=setup(source,meta,record), initial=Buffer.from(arena()), expected=expectNative(initial,record,meta);
      const de=!!word(record,37), result=de ? 3n : 1n, label=`${form}/${row}`;
      assert.equal((word(record,38)^word(record,16))&(de ? ~0x10000n : ~0x8d5n),0n);
      compare(cut,meta,expected,result,`${label}: native/direct`); ++comparisons;
      if (de) ++divideFaults; else ++successes;
      arena().set(initial); open(meta); compare(cut,meta,expected,result,`${label}: native/C-dispatch`,true);
      for (const dispatch of [false,true]) {
        arena().set(initial); put(base+392,word(record,16)|0x10000n); open(meta);
        const rf=Buffer.from(expected); if (de) rf.writeBigUInt64LE(word(record,16)|0x10000n,392);
        compare(cut,meta,rf,result,`${label}: RF ${dispatch}`,dispatch); ++rfChecks;
      }
      // Native #PF wins even where the readable input generated #DE.
      assert.equal(word(pf,37),14n); assert.equal(word(pf,38),4n); assert.equal(word(pf,39),info.address);
      assert.equal(word(pf,33)&~0x10000n,word(pf,16));
      arena().set(initial); put(info.leaf+(info.split ? 8 : 0),0); open(meta);
      const blocked=Buffer.from(arena()), expectedPF=Buffer.from(blocked);
      expectedPF.writeBigUInt64LE(word(pf,35),port-base+16);
      expectedPF.writeUInt32LE(14,port-base+24); expectedPF.writeUInt32LE(4,port-base+28);
      compare(cut,meta,expectedPF,115n,`${label}: native read #PF`); ++pageFaults;
      arena().set(blocked); open(meta); compare(cut,meta,expectedPF,115n,`${label}: C-dispatch #PF`,true);
      for (const dispatch of [false,true]) {
        arena().set(blocked); put(base+392,word(record,16)|0x10000n); open(meta);
        const rf=Buffer.from(expectedPF); rf.writeBigUInt64LE(word(record,16)|0x10000n,392);
        compare(cut,meta,rf,115n,`${label}: #PF RF ${dispatch}`,dispatch); ++rfChecks;
      }
      for (const dispatch of [false,true]) {
        arena().set(initial);
        const rank=info.split ? 5 : 4, physical=info.split ? 0x9000n : 0x8000n;
        const offset=Number(info.address&4095n);
        page(rank,physical,0,3); open(meta);
        const pending=Buffer.from(initial);
        pending.writeBigUInt64LE(physical+BigInt(info.split ? 0 : offset),port-base+32);
        pending.writeUInt32LE(info.split ? info.bytes-(4096-offset) : info.bytes,port-base+40);
        // SS classifies a guest address fault, not the physical page owner.
        pending.writeUInt32LE((meta.access&3)|16,port-base+44);
        compare(cut,meta,pending,2n,`${label}: residency before #DE ${dispatch}`,dispatch); ++waits;
        page(rank,physical,(rank===5 ? nextPage : firstPage)-base); open(meta);
        const resumed=Buffer.from(expected);
        pending.copy(resumed,port-base+32,port-base+32,port-base+48);
        compare(cut,meta,resumed,result,`${label}: exact resumed input ${dispatch}`,dispatch); ++retries;
      }
    }
    const record=native.subarray(0,stride);
    if (!meta.address32 && meta.kind!==5) {
      // Architectural #GP/#SS address-model cases, not native observations.
      // These must precede a divider guard even for aliased RAX/RDX bases.
      for (const address of [0x800000000000n,0xffff7ffffffffffen]) for (const dispatch of [false,true]) {
        setup(source,meta,record);
        if (meta.kind<2) put(base+7*8,address);
        else if (meta.kind<4) put(base+(meta.kind===2 ? 0 : 2)*8,address);
        else if (meta.kind===4) put(base+4*8,address-4n);
        else if (meta.kind===6) put(base+12*8,address);
        else { put(base+8,0); put(base+7*8,address-7n); }
        const expected=Buffer.from(arena()), vector=meta.access&4 ? 12 : 13;
        expected.writeBigUInt64LE(address,port-base+16);
        expected.writeUInt32LE(vector,port-base+24); expected.writeUInt32LE(0,port-base+28);
        compare(cut,meta,expected,BigInt(vector*8+3),`${form}: address fault before divide ${dispatch}`,dispatch);
        ++addressFaultModels;
      }
    }
    for (const failure of ['TF','AC','alias','unaligned','bounds','wrong-rip','stale','closed']) {
      setup(source,meta,record);
      if (failure==='TF') put(base+392,word(record,16)|256n);
      if (failure==='AC') put(base+392,word(record,16)|0x40000n);
      if (failure==='wrong-rip') put(base+384,entry+1n);
      if (failure==='stale') put(port,8);
      if (failure==='closed') vm.vm_close();
      const before=Buffer.from(arena());
      assert.equal(cut(base,failure==='alias' ? base : failure==='unaligned' ? port+1 : failure==='bounds' ? 0xfffffff8 : port),
        failure==='stale' ? 5n : 6n);
      assert(arena().equals(before)); ++refusals;
    }
  }
} finally { vm.__indirect_function_table.set(slot,null); vm.vm_close(); cc.compiler_close(); }
console.log(JSON.stringify({format:'c-wasm-memory-division-native-v1',status:'pass',parity,comparisons,successes,divideFaults,pageFaults,
  dispatchComparisons,rfChecks,waits,retries,refusals,addressFaultModels,oracle:'actual x86 user-mode execution in reference QEMU TCG build VM, not physical hardware',
  undefinedFlags:'incoming representative, not hardware equality',linuxBoot:'not-tested',exceptionDelivery:'not-tested'},null,2));
