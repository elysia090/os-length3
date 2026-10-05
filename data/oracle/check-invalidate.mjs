// Compiled privilege/address matrix plus the actual C MMU and entry fetch.
// This is not an x86 interpreter, hardware oracle or Linux boot claim.
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {seedDisabledDebug} from './machine-observation.mjs';
const [vmFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-invalidate.mjs VM.WASM INVALIDATE-FIXTURE-DIRECTORY');
const names=(await readdir(directory)).filter(x=>/^invalidate-\d+\.json$/.test(x));
assert.equal(names.length,84);
let models=0;
for (const name of names) {
  const prefix=path.join(directory,name.slice(0,-5));
  const meta=JSON.parse(await readFile(`${prefix}.json`));
  const module=await WebAssembly.compile(await readFile(`${prefix}.wasm`));
  assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'}]);
  const memory=new WebAssembly.Memory({initial:2});
  const cut=(await WebAssembly.instantiate(module,{machine:{memory}})).exports.cut;
  assert.equal(cut.length,3,'ABI-2 fixture required');
  const bytes=Buffer.from(memory.buffer), view=new DataView(memory.buffer), state=4096, port=8192;
  for (let cpl=0;cpl<4;++cpl) for (let sample=0;sample<32;++sample) {
    bytes.fill(0x93,state,state+1256); bytes.fill(0xa5,port,port+48);
    seedDisabledDebug(view, state);
    for (let reg=0;reg<16;++reg) view.setBigUint64(state+reg*8,BigInt.asUintN(64,
      [0n,0x400000n,0x800000000000n,0xffff7fffffffffffn,0xffff800000000000n,-1n][sample%6]
      +BigInt(reg*(sample+1))),true);
    const flags=2n|BigInt(sample&7)|(sample&8 ? 0x40000n : 0n)
      |(sample&16 ? 0x10000n : 0n);
    view.setBigUint64(state+384,BigInt(meta.entry),true);
    view.setBigUint64(state+392,flags,true);
    view.setBigUint64(state+488,8n|BigInt(cpl),true);
    view.setBigUint64(state+1128,42n,true);
    const expected=Buffer.from(bytes.subarray(state,state+1256));
    const expectedPort=Buffer.from(bytes.subarray(port,port+48));
    if (cpl) {
      assert.equal(cut(state,port,BigInt(meta.entry)),107n);
      expectedPort.writeBigUInt64LE(BigInt(meta.entry),16);
      expectedPort.writeUInt32LE(13,24); expectedPort.writeUInt32LE(0,28);
    } else {
      assert.equal(cut(state,port,BigInt(meta.entry)),1n);
      expected.writeBigUInt64LE(BigInt(meta.entry)+BigInt(meta.sourceBytes),384);
      expected.writeBigUInt64LE(flags&~0x10000n,392);
      expected.writeBigUInt64LE(43n,1128);
    }
    assert(bytes.subarray(state,state+1256).equals(expected));
    assert(bytes.subarray(port,port+48).equals(expectedPort)); ++models;
  }
  for (const flag of [0x100n,0x20000n]) {
    view.setBigUint64(state+384,BigInt(meta.entry),true);
    view.setBigUint64(state+392,2n|flag,true);
    const before=Buffer.from(bytes);
    assert.equal(cut(state,port,BigInt(meta.entry)),6n); assert(bytes.equals(before)); ++models;
  }
  for (const [s,p] of [[state+1,port],[state,state],[state,state+8],[state,port+1],
    [0xfffffff8,port],[state,0xfffffff8]]) {
    view.setBigUint64(state+384,BigInt(meta.entry),true);
    view.setBigUint64(state+392,2n,true);
    const before=Buffer.from(bytes);
    assert.equal(cut(s,p,BigInt(meta.entry)),6n); assert(bytes.equals(before)); ++models;
  }
}
// Every actual compiled entry still goes through the C walk. Global pages
// and large pages do not create a translation cache. The source/table cache
// must not let a retained compiled module bypass changed execute permissions.
const memory=new WebAssembly.Memory({initial:8});
const vm=(await WebAssembly.instantiate(await readFile(vmFile),{machine:{memory}})).instance.exports;
const bytes=Buffer.from(memory.buffer), view=new DataView(memory.buffer);
const directoryAt=vm.vm_arena_min(), rows=directoryAt+512, base=directoryAt+4096;
const port=base+2048, segments=base+1408, table=vm.__indirect_function_table, slot=vm.vm_slot_min();
table.grow(Math.max(0,slot+1-table.length));
const put=(at,v)=>view.setBigUint64(at,BigInt(v),true);
for (let i=0;i<7;++i) {
  const at=directoryAt+i*32; put(at,i<4 ? (i+1)*4096 : (i+4)*4096);
  view.setUint32(at+8,(i+2)*4096,true); view.setUint32(at+12,3,true); view.setUint32(at+16,1,true);
}
const pte=base+20480, code=base+24576, first=base+28672, second=base+32768;
put(base+8192,0x2007); put(base+12288,0x3007); put(base+16384+16,0x4007);
put(pte,0x8007); put(pte+8,0x9107); put(pte+16,0x4007);
put(port,9); put(base+384,0x400000); put(base+392,2);
put(base+400,0x80010001); put(base+408,0x1000); put(base+416,0xa0); put(base+424,0xd00);
put(base+488,8); put(base+56,0x800000000000n);
view.setUint32(segments,2,true); view.setUint32(segments+36,0xa09b,true);
const source=await readFile(path.join(directory,'invalidate-0.source-page'));
bytes.set(source,code);
put(first,0x1111); put(second,0x2222);
assert.equal(vm.vm_open(base,memory.buffer.byteLength-base,4096,directoryAt,7,7,directoryAt+1024,9n),0);
assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
const cut=(await WebAssembly.instantiate(await readFile(path.join(directory,'invalidate-0.wasm')),
  {machine:{memory}})).instance.exports.cut;
table.set(slot,cut);
put(rows,0x400000); view.setUint32(rows+8,3,true); view.setUint32(rows+12,1,true);
view.setUint32(rows+16,slot,true); view.setUint32(rows+20,0,true);
// First fetch legitimately sets A and revokes admission; warm its walk before
// binding so this assertion tests the compiled cut, not that separate retry.
assert.equal(vm.vm_access(port,0x400000n,1,9,0n),0n);
assert.equal(vm.vm_bind_execution(rows,1,9n),0);
assert.equal(vm.vm_run(port,9n,1),1n); assert.equal(vm.vm_source_retired(),1n);
assert.equal(view.getBigUint64(base+384,true),0x400003n);
let mmu=0;
for (let iteration=0;iteration<64;++iteration) {
  const target=iteration&1 ? 0xa107n : 0x9107n;
  assert.equal(vm.vm_access(port,0x402008n,8,2,target),0n); // guest write to PTE alias
  put(base+384,0x400000); put(base+392,0x10002);
  const ram=Buffer.from(bytes.subarray(base+8192,base+36864));
  assert.equal(cut(base,port,0x400000n),1n);
  assert(bytes.subarray(base+8192,base+36864).equals(ram),'INVLPG cannot read or set A/D');
  assert.equal(vm.vm_access(port,0x401000n,8,1,0n),0n);
  assert.equal(view.getBigUint64(port+8,true),iteration&1 ? 0x2222n : 0x1111n);
  assert.equal(view.getBigUint64(pte+8,true)&96n,32n);
  assert.equal(vm.vm_access(port,0x401000n,8,2,BigInt(iteration)),0n);
  assert.equal(view.getBigUint64(pte+8,true)&96n,96n);
  // Restore payload for the next alternation; this is test setup, not execution.
  put(first,0x1111); put(second,0x2222); ++mmu;
}
// Retain the same table slot but remove execute permission, then presence.
for (const [leaf,error] of [[0x8000000000008107n,17],[0n,16]]) {
  assert.equal(vm.vm_access(port,0x402000n,8,2,leaf),0n);
  put(base+384,0x400000); put(base+392,2);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  const before=Buffer.from(bytes.subarray(base,base+1256));
  assert.equal(vm.vm_run(port,9n,1),115n);
  assert.equal(vm.vm_source_retired(),0n); assert.equal(view.getUint32(port+28,true),error);
  assert(bytes.subarray(base,base+1256).equals(before)); ++mmu;
}
console.log(`INVLPG: ${names.length} modules / ${models} address/privilege/reservation model cases; ${mmu} actual C-MMU remap/A-D/fetch cases green; NOT Linux boot or hardware TLB proof`);
