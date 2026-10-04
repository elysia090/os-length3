// Actual C-MMU/provider plus independent native store receipts. JavaScript
// supplies/compares test inputs; it implements no guest descriptor operation.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {seedDisabledDebug} from './machine-observation.mjs';
const [vmFile,compilerFile,directory,observationFile]=process.argv.slice(2);
if (!observationFile) throw new Error('usage: check-descriptor-transfer.mjs VM.WASM COMPILER.WASM FIXTURES NATIVE-OBSERVATION.json');
const memory=new WebAssembly.Memory({initial:8,maximum:16}), coldMemory=new WebAssembly.Memory({initial:16});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const cc=(await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:coldMemory}})).instance.exports;
let data=Buffer.from(memory.buffer), view=new DataView(memory.buffer);
const cold=Buffer.from(coldMemory.buffer), cv=new DataView(coldMemory.buffer), coldInput=cc.compiler_arena_min();
const coldOutput=coldInput+8192, report=coldOutput+65536;
const input=vm.vm_arena_min(), dir=input+8192, rows=dir+512, branches=input+12288, base=input+16384;
const state=base, segments=base+1408, port=base+2048, request=base+2176, first=base+28672, second=base+32768;
const entry=0x400000n, slot=vm.__indirect_function_table.grow(1);
const put=(at,value)=>view.setBigUint64(at,BigInt(value),true), dword=(at,value)=>view.setUint32(at,value,true);
const observed=JSON.parse(await readFile(observationFile));
assert.equal(observed.format,'native-descriptor-store-observation-v1');
assert.equal(observed.rows.length,108);
// Row count alone cannot prove the native grid: a stale siglongjmp in the
// observer can duplicate loop coordinates and silently omit address forms.
const nativeKeys=new Set(observed.rows.map(row=>
  [row.table,row.prefix,row.address32,row.offset,row.protection].join(':')));
assert.equal(nativeKeys.size,108,'native observation coordinates must be unique');
for (let table=0;table<2;++table) for (let prefix=0;prefix<3;++prefix)
for (let address32=0;address32<2;++address32) for (const offset of [4085,4086,4094])
for (let protection=0;protection<3;++protection)
  assert(nativeKeys.has([table,prefix,address32,offset,protection].join(':')));
let parity=0, models=0, nativeComparisons=0, waits=0, retries=0, refusals=0, abortPreservations=0;
function header() {
  data.fill(0,input,input+8192); data[input+0x1f1]=31; data[input+0x200]=0xeb; data[input+0x201]=0x6a;
  view.setUint16(input+0x1fe,0xaa55,true); dword(input+0x202,0x53726448); view.setUint16(input+0x206,0x20f,true);
  data[input+0x211]=1; data[input+0x236]=1; dword(input+0x1f4,0x2e640); dword(input+0x230,0x200000);
  put(input+0x258,0x1000000); dword(input+0x260,0xe62000); dword(input+0x22c,0x37ffffff); dword(input+0x238,2047);
  assert.equal(vm.vm_boot_prepare(input,4096,0x2ea400n,0x65432n,0x8000000n,input+4096,0),0);
}
function reset(source,meta,offset,cpl=0,umip=0,protection=0,residentSecond=true,sample=0) {
  data.fill(0,base); data.fill(0,dir,dir+1024); header();
  for (let i=0;i<(residentSecond ? 6 : 5);++i) {
    const at=dir+i*32; put(at,i<4 ? (i+1)*4096 : (i+4)*4096);
    dword(at+8,i<4 ? (i+2)*4096 : i===4 ? first-base : second-base);
    dword(at+12,3); dword(at+16,1);
  }
  put(base+8192,0x2067); put(base+12288,0x3067); put(base+16384+16,0x4067);
  put(base+20480,0x8067); put(base+20488,protection===1 ? 0 : protection===2 ? 0x9065 : 0x9067);
  data.fill(0xa5,first,first+4096); data.fill(0xa5,second,second+4096); data.set(source.subarray(0,16),first);
  data.fill(0x93,state,state+1256);
  seedDisabledDebug(view, state);
  const address=meta.shape===3 ? entry+BigInt(meta.sourceBytes+512) : entry+BigInt(offset);
  for (let reg=0;reg<16;++reg) put(state+reg*8,0xabcdef9800000000n+BigInt(reg*256+sample));
  put(state+7*8,address); put(state+4*8,address-14n); put(state+12*8,address-18n); put(state+8,1);
  if (meta.address32) for (const reg of [7,4,12]) put(state+reg*8,view.getBigUint64(state+reg*8,true)|0xdeadbeef00000000n);
  put(state+384,entry); put(state+392,2|(sample&1 ? 0x8d5 : 0)|(sample&2 ? 0x10000 : 0));
  put(state+400,0x80010011); put(state+408,0x1000); put(state+416,32|(umip<<11)); put(state+424,0xd00);
  put(state+488,8|cpl); put(state+1128,42); put(state+448,0x0123456789abcdefn); put(state+456,0xfedc);
  put(state+464,0xffff800000123456n); put(state+472,0x4321); put(port,9);
  dword(segments,2); dword(segments+36,0xa09b|(cpl<<5));
  assert.equal(vm.vm_open(base,data.length-base,4096,dir,residentSecond ? 6 : 5,8,branches,9n),0);
  assert.equal(vm.vm_bind_state(state),0); assert.equal(vm.vm_bind_segments(segments),0);
  put(rows,entry); dword(rows+8,meta.sourceBytes); dword(rows+12,1); dword(rows+16,slot); dword(rows+20,0);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  return address;
}
function cpu(success,meta) {
  const expected=Buffer.from(data.subarray(state,state+1256));
  if (success) {
    expected.writeBigUInt64LE(entry+BigInt(meta.sourceBytes),384);
    expected.writeBigUInt64LE(expected.readBigUInt64LE(392)&~0x10000n,392); expected.writeBigUInt64LE(43n,1128);
  }
  return expected;
}
function descriptor(meta) {
  const out=Buffer.alloc(10), at=state+448+meta.table*16;
  out.writeUInt16LE(Number(view.getBigUint64(at+8,true)),0); out.writeBigUInt64LE(view.getBigUint64(at,true),2);
  return out;
}
for (let rank=0;rank<96;++rank) {
  const prefix=path.join(directory,`table-${rank}`), meta=JSON.parse(await readFile(`${prefix}.json`));
  const source=await readFile(`${prefix}.source-page`), emitted=await readFile(`${prefix}.wasm`);
  cold.set(source,coldInput); assert.equal(cc.compiler_open_pages(coldInput,1,entry,9n),0);
  assert.equal(cc.compiler_emit(entry,1,coldOutput,65536,report),0);
  assert.equal(cv.getBigUint64(report+40,true),BigInt(emitted.length));
  assert(cold.subarray(coldOutput,coldOutput+emitted.length).equals(emitted)); ++parity;
  const module=await WebAssembly.compile(emitted);
  assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'},
    {module:'machine',name:'table',kind:'function'}]);
  const cut=(await WebAssembly.instantiate(module,{machine:{memory,table:vm.vm_table}})).exports.cut;
  vm.__indirect_function_table.set(slot,cut);
  for (let cpl=0;cpl<4;++cpl) for (let umip=0;umip<2;++umip)
  for (const offset of [64,4085,4086,4087,4093,4094,4095]) for (let protection=0;protection<3;++protection) {
    const address=reset(source,meta,offset,cpl,umip,protection,true,offset);
    const actualOffset=Number(address-entry), denied=meta.store ? cpl>0 && umip : cpl>0;
    const pageFault=!denied && (protection===1 || protection===2 && meta.store) && actualOffset+10>4096;
    const expected=cpu(!denied && !pageFault,meta), payload=Buffer.from(data.subarray(first,second+4096));
    const hidden=Buffer.from(data.subarray(segments,segments+136)), record=descriptor(meta);
    let result=denied ? 107n : pageFault ? 115n : meta.store ? 5n : 1n;
    if (!denied && meta.store) {
      if (!pageFault) record.copy(payload,actualOffset);
      else if (actualOffset<=4094) record.copy(payload,actualOffset,0,2);
    }
    if (!denied && !pageFault && !meta.store) {
      const at=448+meta.table*16;
      expected.writeBigUInt64LE(payload.readBigUInt64LE(actualOffset+2),at);
      expected.writeBigUInt64LE(BigInt(payload.readUInt16LE(actualOffset)),at+8);
    }
    assert.equal(vm.vm_run(port,9n,1),result,`form ${rank} CPL=${cpl} UMIP=${umip} offset=${offset} protection=${protection}`);
    assert.deepEqual(data.subarray(state,state+1256),expected);
    assert.deepEqual(data.subarray(segments,segments+136),hidden); assert.deepEqual(data.subarray(first,second+4096),payload);
    assert.equal(vm.vm_completed(),!denied && !pageFault ? 1 : 0); assert.equal(vm.vm_source_retired(),!denied && !pageFault ? 1n : 0n);
    if (denied || pageFault) {
      assert.equal(view.getUint32(port+24,true),denied ? 13 : 14);
      assert.equal(view.getBigUint64(port+16,true),denied ? entry : entry+4096n);
      assert.equal(view.getUint32(port+28,true),denied ? 0 : (protection===2 ? 1 : 0)|(meta.store ? 2 : 0)|(cpl===3 ? 4 : 0));
    }
    ++models;
  }
  // Actual native payload/fault evidence, not a generated expected opcode.
  if (meta.store && meta.shape===0) for (const row of observed.rows.filter(row=>
      row.table===meta.table && row.prefix===meta.prefix && row.address32===meta.address32)) {
    assert.equal(row.faultRipAtSource,true);
    reset(source,meta,row.offset,3,0,row.protection);
    const record=Buffer.from(row.descriptor), at=state+448+meta.table*16;
    put(at,record.readBigUInt64LE(2)); put(at+8,record.readUInt16LE(0));
    assert.equal(cut(state,port),row.vector ? 115n : 1n);
    assert.deepEqual(data.subarray(first+row.offset-3,first+row.offset+13),Buffer.from(row.payload));
    if (row.vector) {
      assert.equal(view.getUint32(port+24,true),row.vector); assert.equal(view.getUint32(port+28,true),row.error);
      assert.equal(view.getBigUint64(port+16,true),entry+BigInt(row.faultOffset));
    }
    ++nativeComparisons;
  }
  if (meta.shape!==3) for (const offset of [4087,4094,4095]) {
    reset(source,meta,offset,0,0,0,false);
    const expected=cpu(true,meta), record=descriptor(meta), before=Buffer.from(data.subarray(state,state+1256));
    assert.equal(vm.vm_run(port,9n,1),2n); assert.equal(vm.vm_completed(),0); assert.equal(vm.vm_source_retired(),0n); ++waits;
    assert.deepEqual(data.subarray(state,state+1256),before);
    const limitCommitted=meta.store && offset<=4094;
    if (limitCommitted) assert.deepEqual(data.subarray(first+offset,first+offset+2),record.subarray(0,2));
    // Current compiled slot/source is pinned, including a completed RAM write.
    assert.equal(vm.vm_sources_reset(),-1); ++refusals;
    if (meta.store) { assert.equal(vm.vm_bind_execution(rows,1,9n),-1); ++refusals; }
    assert.equal(vm.vm_page_prepare(port,request),0);
    const ticket=view.getBigUint64(request+40,true), target=view.getUint32(request+24,true);
    assert.equal(view.getBigUint64(request+8,true),0x9000n); assert.equal(target,second);
    if (meta.store) {
      // Refusal must preserve the prepared supply ticket and table frontier,
      // not just the visible CPU. None of these can advance another guest cut.
      const pending=Buffer.from(data.subarray(base,base+4096));
      for (const refused of [
        ()=>vm.vm_access(port,entry,1,1,0n),
        ()=>vm.vm_code(port,entry,request+64),
        ()=>vm.vm_source_query(port,entry,1,request+64,rows),
        ()=>vm.vm_source_extend(port,request+64,rows),
        ()=>vm.vm_reserve(port,entry,1,2), ()=>vm.vm_commit(port,0n),
        ()=>vm.vm_io(port,0x80,1,0n), ()=>vm.vm_time(port),
        ()=>vm.vm_return(port,0), ()=>vm.vm_fault(port), ()=>vm.vm_iret(port),
        ()=>vm.vm_control(port,3,0n), ()=>vm.vm_msr(port,0,0,0n),
        ()=>vm.vm_segment(port,0,0)
      ]) {
        assert.equal(refused(),6n); ++refusals;
        assert.deepEqual(data.subarray(base,base+4096),pending);
        assert.equal(vm.vm_page_prepare(port,request),0,'refusal must not cancel page supply');
        assert.equal(view.getBigUint64(request+40,true),ticket);
      }
      vm.vm_abort();
      assert.deepEqual(data.subarray(base,base+4096),pending);
      assert.equal(vm.vm_page_prepare(port,request),0);
      assert.equal(view.getBigUint64(request+40,true),ticket); ++abortPreservations;
    }
    data.fill(0xa5,target,target+4096);
    // Make the first page read-only after the first store. Replaying that
    // limit would #PF; continuing just the captured base must still succeed.
    if (limitCommitted && offset===4094) put(base+20480,0x8065);
    assert.equal(vm.vm_page_commit(port,ticket),0); assert.equal(vm.vm_page_commit(port,ticket),-1); ++refusals;
    assert.equal(vm.vm_run(port,9n,1),meta.store ? 5n : 1n);
    if (!meta.store) {
      expected.writeBigUInt64LE(0xa5a5a5a5a5a5a5a5n,448+meta.table*16);
      expected.writeBigUInt64LE(0xa5a5n,456+meta.table*16);
    }
    assert.deepEqual(data.subarray(state,state+1256),expected);
    if (meta.store) assert.deepEqual(data.subarray(first+offset,first+offset+10),record);
    assert.equal(vm.vm_completed(),1); assert.equal(vm.vm_source_retired(),1n); ++retries;
  }
  reset(source,meta,64);
  for (const flag of [0x100n,0x40000n]) {
    put(state+392,2n|flag); const before=Buffer.from(data.subarray(state,state+4096));
    assert.equal(cut(state,port),6n); assert.deepEqual(data.subarray(state,state+4096),before); ++refusals;
  }
}
vm.__indirect_function_table.set(slot,null); cc.compiler_close(); vm.vm_close();
assert.equal(nativeComparisons,108,'every native coordinate must be compared');
console.log(JSON.stringify({format:'c-wasm-descriptor-transfer-v1',status:'pass',parity,models,nativeComparisons,waits,retries,refusals,abortPreservations,
  oracle:'actual x86 user-mode payload/#PF in reference QEMU TCG build VM; other state/UMIP cases are explicit models',
  cpuProfile:'unchanged; UMIP models do not advertise or enable that feature',linuxBoot:'not-tested',exceptionDelivery:'not-tested'},null,2));
