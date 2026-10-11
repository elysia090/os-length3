// Actual C-Wasm source admission and physical write observation. This is a
// boundary regression, not a Linux boot or a cryptographic module proof.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile] = process.argv.slice(2);
if (!compilerFile) throw new Error('usage: check-source-admission.mjs VM.WASM COMPILER.WASM');
const memory = new WebAssembly.Memory({initial:64,maximum:66});
const provider = await WebAssembly.compile(await readFile(vmFile));
assert.deepEqual(WebAssembly.Module.imports(provider),[{module:'machine',name:'memory',kind:'memory'}]);
const sharedMemory = new WebAssembly.Memory({initial:64,maximum:66,shared:true});
await assert.rejects(() => WebAssembly.instantiate(provider,{machine:{memory:sharedMemory}}),WebAssembly.LinkError);
const vm = (await WebAssembly.instantiate(provider,{machine:{memory}})).exports;
const coldMemory = new WebAssembly.Memory({initial:64});
const cc = (await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:coldMemory}})).instance.exports;
const cold = new Uint8Array(coldMemory.buffer), report = new DataView(coldMemory.buffer);
let data = new Uint8Array(memory.buffer), view = new DataView(memory.buffer);
const directory = vm.vm_arena_min(), rows = directory + 1024, branches = directory + 2048, base = directory + 4096;
const port = base + 2048, segments = base + 1408, codeView = base + 2112;
const code = base + 24576, firstSlot = vm.vm_slot_min(), table = vm.__indirect_function_table;
let memoryLive=false;
table.grow(Math.max(0,firstSlot + vm.vm_source_capacity() - table.length));
data.fill(0,directory);
function put(at,value) {
  if(memoryLive&&(at===base+20480||at===base+20488)){
    // Change page tables through the C physical-store observer, not an
    // unannounced host edit behind its successful-walk certificates.
    assert.equal(vm.vm_access(port,0x400000n+510n*4096n+BigInt(at-base-20480),8,2,BigInt(value)),0n);
  }else view.setBigUint64(at,BigInt(value),true);
}
for (let i = 0; i < 6; ++i) {
  const row = directory + i * 32;
  put(row,i < 4 ? (i+1)*4096 : (i+4)*4096);
  view.setUint32(row + 8,(i+2)*4096,true); view.setUint32(row + 12,3,true);
  view.setUint32(row + 16,1,true);
}
put(base + 8192,0x2007); put(base + 12288,0x3007);
put(base + 16384 + 16,0x4007); put(base + 20480,0x8007); put(base + 20488,0x9007);
put(base+20480+510*8,0x4067);
put(port,9); put(base + 384,0x400000); put(base + 392,3);
put(base + 400,0x80010001); put(base + 408,0x1000); put(base + 416,32); put(base + 424,0xd00);
put(base + 488,16); put(base + 504,24);
view.setUint32(segments,2,true); view.setUint32(segments + 36,0xa09b,true);
data[code] = 0x90;
assert.equal(vm.vm_open(base,memory.buffer.byteLength-base,4096,directory,6,6,branches,9n),0);
memoryLive=true;
assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
let emitted = 0;
function query(limit = 1,entry = 0x400000n) { return vm.vm_source_query(port,entry,limit,codeView,rows); }
async function publish(entry = 0x400000n) {
  const slot = view.getUint32(rows + 16,true);
  assert(slot >= firstSlot && slot < firstSlot + vm.vm_source_capacity());
  const input = cc.compiler_arena_min(), output = input + 8192, receipt = output + 65536;
  const count = view.getUint32(codeView + 44,true) ? 2 : 1;
  for (let i=0;i<count;++i) {
    const at = view.getUint32(codeView + i*24 + 16,true);
    cold.set(data.subarray(at,at + 4096),input + i*4096);
  }
  assert.equal(cc.compiler_open_pages(input,count,entry & ~4095n,9n),0);
  assert.equal(cc.compiler_emit(entry,1,output,65536,receipt),0);
  const length = Number(report.getBigUint64(receipt + 40,true));
  const generated = cold.slice(output,output+length);
  if (!emitted) await assert.rejects(() => WebAssembly.instantiate(generated,{
    machine:{memory:sharedMemory,access:vm.vm_access,reserve:vm.vm_reserve,commit:vm.vm_commit},
  }),WebAssembly.LinkError);
  const instance = await WebAssembly.instantiate(generated,{
    machine:{memory,access:vm.vm_access,reserve:vm.vm_reserve,commit:vm.vm_commit},
  });
  table.set(slot,instance.instance.exports.cut);
  assert.equal(vm.vm_source_publish(Number(report.getBigUint64(receipt + 32,true)),
    Number(report.getBigUint64(receipt + 24,true)),report.getUint32(receipt+76,true),rows),0); ++emitted;
}
function run() {
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  assert.equal(vm.vm_run(port,9n,1),1n); assert.equal(vm.vm_source_retired(),1n);
  put(base + 384,0x400000);
}
assert.equal(query(),1n); await publish(); run();
assert.equal(query(),0n); run(); assert.equal(emitted,1);
// This store invokes the provider's OWN C observer, whose table slot must not
// have been overwritten by the generated function (previously a real trap).
assert.equal(vm.vm_access(port,0x400080n,1,2,1n),0n);
assert.equal(query(),0n); run();
assert.equal(vm.vm_access(port,0x400000n,1,2,0x90n),0n);
assert.equal(query(),1n); // Even equal-value source stores revoke.
assert.equal(vm.vm_access(port,0x400100n,1,2,1n),0n);
assert.equal(vm.vm_source_publish(1,1,0,rows),-1); // Unknown compile span was pinned page-wide.
assert.equal(query(),1n); await publish();
assert.equal(vm.vm_access(port,0x400000n,1,2,0xf8n),0n);
assert.equal(query(),1n); await publish(); run();
assert.equal(view.getBigUint64(base + 392,true),2n); // Newly compiled CLC, not stale NOP.
assert.equal(query(),0n);
assert.equal(vm.vm_reserve(port,0x400000n,1,3),0n);
assert.equal(vm.vm_commit(port,0x90n),0n);
assert.equal(query(),1n); await publish();
// Permission must be checked before a cache hit after an announced PTE store.
const leaf = base + 20480, previous = view.getBigUint64(leaf,true);
put(leaf,previous | (1n << 63n));
data.fill(0xa5,codeView,codeView + 48); data.fill(0xa5,rows,rows + 24);
assert.equal(query(),115n); assert.equal(view.getUint32(port + 28,true),17);
assert(data.subarray(codeView,codeView+48).every(x => x === 0xa5));
assert(data.subarray(rows,rows+24).every(x => x === 0xa5));
put(leaf,previous); assert.equal(vm.vm_sources_reset(),0);
assert.equal(query(),1n); await publish(); assert.equal(query(),0n);
memory.grow(1); data = new Uint8Array(memory.buffer); view = new DataView(memory.buffer);
assert.equal(vm.vm_grow(),0); assert.equal(query(),0n);
put(port,8); assert.equal(query(),5n); put(port,9);
assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
assert.equal(query(),1n); await publish(); run();
// Demand-driven first-instruction tail. The next VA deliberately has a
// non-contiguous physical owner; JS only copies C-verified borrowed views.
const entry = 0x400fffn, tail = base+32768, tailRow = directory+5*32;
view.setUint32(tailRow+8,32768,true); // Supervisor rebind revokes this fixture mutation.
data[code+4095] = 0x48; data[tail] = 0x89; data[tail+1] = 0xc0;
assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
put(base+384,entry); put(base,0x1020304050607080n);
const tailLeaf = leaf+8, tailPte = view.getBigUint64(tailLeaf,true);
put(tailLeaf,tailPte | (1n<<63n));
assert.equal(query(1,entry),1n); // Never fetch the next page speculatively.
assert.equal(view.getUint32(codeView+44,true),0);
const input = cc.compiler_arena_min(), output = input+8192, receipt = output+65536;
cold.set(data.subarray(code,code+4096),input);
assert.equal(cc.compiler_open_pages(input,1,0x400000n,9n),0);
cold.fill(0xa5,output,receipt+80);
assert.equal(cc.compiler_emit(entry,1,output,65536,receipt),-105);
assert(cold.subarray(output,receipt+80).every(x => x===0xa5));
function unchangedFault(request,error) {
  data.fill(0xa5,codeView,codeView+48); data.fill(0xa5,rows,rows+24);
  const cpu = data.slice(base,base+1408);
  assert.equal(request(),115n); assert.equal(view.getUint32(port+28,true),error);
  assert.equal(view.getBigUint64(port+16,true),0x401000n);
  assert(data.subarray(codeView,codeView+48).every(x => x===0xa5));
  assert(data.subarray(rows,rows+24).every(x => x===0xa5));
  assert(data.subarray(base,base+1408).every((x,i) => x===cpu[i]));
}
unchangedFault(() => vm.vm_source_extend(port,codeView,rows),17);
put(tailLeaf,tailPte);
assert.equal(vm.vm_source_extend(port,codeView,rows),1n);
assert.equal(view.getUint32(codeView+40,true),tail);
await publish(entry);
assert.equal(query(1,entry),0n);
assert.equal(vm.vm_bind_execution(rows,1,9n),0);
assert.equal(vm.vm_run(port,9n,1),1n); assert.equal(vm.vm_source_retired(),1n);
assert.equal(view.getBigUint64(base+384,true),0x401002n);
assert.equal(view.getBigUint64(base,true),0x1020304050607080n);
put(base+384,entry);
// Both permissions are rechecked on every cached crossing admission, and
// execution rechecks them too. A missing tail is not a compiler fallback.
const acceptedRow = data.slice(rows,rows+24);
put(tailLeaf,tailPte | (1n<<63n));
unchangedFault(() => query(1,entry),17);
data.set(acceptedRow,rows); // Restore the deliberately poisoned test output.
assert.equal(vm.vm_bind_execution(rows,1,9n),0);
assert.equal(vm.vm_run(port,9n,1),115n); assert.equal(vm.vm_source_retired(),0n);
assert.equal(view.getBigUint64(base+384,true),entry);
put(tailLeaf,0n); unchangedFault(() => query(1,entry),16);
put(tailLeaf,tailPte); assert.equal(query(1,entry),0n);
// Actual C-RAM writes, exact extent and pending whole-page cancellation.
assert.equal(vm.vm_access(port,0x401002n,1,2,0x90n),0n); assert.equal(query(1,entry),0n);
assert.equal(vm.vm_access(port,0x401001n,1,2,0xc0n),0n); assert.equal(query(1,entry),1n);
assert.equal(vm.vm_source_extend(port,codeView,rows),1n);
assert.equal(vm.vm_access(port,0x401080n,1,2,1n),0n);
assert.equal(vm.vm_source_publish(3,1,0,rows),-1);
assert.equal(query(1,entry),1n); assert.equal(vm.vm_source_extend(port,codeView,rows),1n);
await publish(entry);
assert.equal(vm.vm_access(port,entry,1,2,0x48n),0n); assert.equal(query(1,entry),1n);
assert.equal(vm.vm_source_extend(port,codeView,rows),1n); await publish(entry);
// Same virtual tail remapped to the first physical page must compile again.
put(tailLeaf,0x8007n); assert.equal(query(1,entry),1n);
assert.equal(view.getUint32(codeView+40,true),code);
put(tailLeaf,tailPte); assert.equal(query(1,entry),1n);
assert.equal(vm.vm_source_extend(port,codeView,rows),1n); await publish(entry);
// An absent PHYSICAL owner asks for residency, not a guest #PF or execution.
view.setUint32(tailRow+16,3,true);
data.fill(0xa5,codeView,codeView+48); data.fill(0xa5,rows,rows+24);
assert.equal(query(1,entry),2n);
assert(data.subarray(codeView,codeView+48).every(x => x===0xa5));
assert(data.subarray(rows,rows+24).every(x => x===0xa5));
view.setUint32(tailRow+16,1,true); assert.equal(query(1,entry),0n);
memory.grow(1); data = new Uint8Array(memory.buffer); view = new DataView(memory.buffer);
assert.equal(vm.vm_grow(),0); assert.equal(query(1,entry),0n);
put(port,8n); assert.equal(query(1,entry),5n); put(port,9n);
assert.equal(vm.vm_sources_reset(),0); assert.equal(query(1,entry),1n);
assert.equal(vm.vm_source_extend(port,codeView,rows),1n);
put(port,8n); assert.equal(vm.vm_source_extend(port,codeView,rows),5n); put(port,9n);
assert.equal(vm.vm_sources_reset(),0);
// The first source physically aliases its leaf-table page. Tail admission
// writes that page's A bit and must cancel the outstanding compile pin, even
// when the write lies outside the eventual three-byte instruction extent.
put(leaf,0x4007n); put(tailLeaf,0x9007n); data[base+20480+4095] = 0x48;
assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
assert.equal(query(1,entry),1n);
data.fill(0xa5,codeView,codeView+48); data.fill(0xa5,rows,rows+24);
assert.equal(vm.vm_source_extend(port,codeView,rows),5n);
assert(data.subarray(codeView,codeView+48).every(x => x===0xa5));
assert(data.subarray(rows,rows+24).every(x => x===0xa5));
assert.equal(vm.vm_source_publish(3,1,0,rows),-1);
assert.equal(query(1,entry),1n);
assert.equal(vm.vm_source_extend(port,codeView,rows),1n);
assert.equal(view.getUint32(codeView+16,true),base+20480);
// Both CMPXCHG arms, with/without LOCK, perform a real write cycle even when
// the resulting byte is equal. The C dispatcher must retire exactly once,
// then fence source aliases before invoking any further compiled code.
for (const locked of [false,true]) for (const equal of [false,true]) {
  const source = locked ? [0xf0,0x48,0x0f,0xb1,0x0f,0x90,0x90,0x90] : [0x48,0x0f,0xb1,0x0f,0x90,0x90,0x90,0x90];
  put(leaf,0x8067n); put(tailLeaf,tailPte); data.set(source,code);
  const original = view.getBigUint64(code,true), originalBytes = data.slice(code,code+8);
  put(base,equal ? original : 0n); put(base+8,original); put(base+56,0x400000n);
  put(base+384,0x400000n); put(base+392,3n);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
  assert.equal(query(),1n); await publish();
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  assert.equal(vm.vm_run(port,9n,1),5n);
  assert.equal(vm.vm_completed(),1); assert.equal(vm.vm_source_retired(),1n);
  assert.equal(view.getBigUint64(base+384,true),0x400000n+BigInt(locked ? 5 : 4));
  assert.equal(view.getBigUint64(base,true),original);
  assert.deepEqual(data.slice(code,code+8),originalBytes);
  put(base+384,0x400000n); assert.equal(query(),1n);
}
// Memory SETcc uses the same C store boundary on both truth values. False
// writes zero over the already-zero ModRM byte; equal bytes still invalidate.
for (const equal of [false,true]) {
  put(leaf,0x8067n); data.set([0x0f,0x94,0x00],code);
  put(base,0x400002n); put(base+384,0x400000n); put(base+392,equal ? 0x43n : 3n);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
  assert.equal(query(),1n); await publish();
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  assert.equal(vm.vm_run(port,9n,1),5n);
  assert.equal(vm.vm_completed(),1); assert.equal(vm.vm_source_retired(),1n);
  assert.equal(view.getBigUint64(base+384,true),0x400003n);
  assert.equal(view.getBigUint64(base,true),0x400002n);
  assert.equal(view.getBigUint64(base+392,true),equal ? 0x43n : 3n);
  assert.equal(data[code+2],equal ? 1 : 0);
  put(base+384,0x400000n); assert.equal(query(),1n);
}
// The signed bit-string offset selects the source owner, not the original
// base coordinate. Positive indexes start on the unmapped preceding VA;
// negative indexes start in the following word. BT only observes, whereas
// an equal-value BTS still writes and must fence that physical source alias.
for (const write of [false,true]) for (const index of [-61n,67n]) {
  put(leaf,0x8067n); data.set([0x48,0x0f,write ? 0xab : 0xa3,0x0f,0x90,0x90,0x90,0x90],code);
  const originalBytes = data.slice(code,code+8);
  const originalBase = index < 0n ? 0x400008n : 0x3ffff8n;
  put(base+8,BigInt.asUintN(64,index)); put(base+56,originalBase);
  put(base+384,0x400000n); put(base+392,2n);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
  assert.equal(query(),1n); await publish();
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  assert.equal(vm.vm_run(port,9n,1),write ? 5n : 1n);
  assert.equal(vm.vm_completed(),1); assert.equal(vm.vm_source_retired(),1n);
  assert.equal(view.getBigUint64(base+384,true),0x400004n);
  assert.equal(view.getBigUint64(base+392,true),3n);
  assert.equal(view.getBigUint64(base+8,true),BigInt.asUintN(64,index));
  assert.equal(view.getBigUint64(base+56,true),originalBase);
  assert.deepEqual(data.slice(code,code+8),originalBytes);
  put(base+384,0x400000n); assert.equal(query(),write ? 1n : 0n);
}
// POP is an ordered stack read then destination write, not a single RMW.
// Exact code aliases fence even when bytes are unchanged. A disjoint
// same-page write retains the row; its next use is still physically admitted.
for (const [rank,address] of [0x400000n,0x400000n,0x400080n].entries()) {
  put(leaf,0x8067n); put(leaf+8,0x9067n);
  data.set([0x8f,0x07,0x90,0x90,0x90,0x90,0x90,0x90],code);
  const oldBytes = data.slice(code,code+8), stackAt = base+view.getUint32(directory+5*32+8,true)+256;
  data.set(rank === 1 ? new Uint8Array(8).fill(0x90) : oldBytes,stackAt);
  put(base+32,0x401100n); put(base+56,address); put(base+384,0x400000n); put(base+392,2n);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
  assert.equal(query(),1n); await publish(); assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  const beforeStack = data.slice(stackAt,stackAt+8);
  assert.equal(vm.vm_run(port,9n,1),rank===2?1n:5n); assert.equal(vm.vm_completed(),1); assert.equal(vm.vm_source_retired(),1n);
  assert.equal(view.getBigUint64(base+32,true),0x401108n); assert.equal(view.getBigUint64(base+384,true),0x400002n);
  assert.equal(view.getBigUint64(base+392,true),2n); assert.deepEqual(data.slice(stackAt,stackAt+8),beforeStack);
  assert.deepEqual(data.slice(code+Number(address-0x400000n),code+Number(address-0x400000n)+8),beforeStack);
  put(base+384,0x400000n); assert.equal(query(),rank === 2 ? 0n : 1n);
}
// The C source owner, not just the host engine cache, must preserve a hot
// admitted body under cold traffic. Execute each real compiled cold NOP and
// hot CLC through the C dispatcher; never trust a slot without its admission.
put(leaf,0x8067n); put(tailLeaf,0x9067n); data.fill(0x90,code,code+4096); data[code]=0xf8;
put(base+384,0x400000n); put(base+392,3n);
assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
assert.equal(query(),1n); await publish();
const hotSlot=view.getUint32(rows+16,true);
let hotDemands=0,coldDemands=0;
function observeExecution(entry,flags) {
  put(base+384,entry); put(base+392,3n);
  const expected=data.slice(base,base+1256), expectedView=new DataView(expected.buffer);
  expectedView.setBigUint64(384,entry+1n,true); expectedView.setBigUint64(392,flags,true);
  expectedView.setBigUint64(1128,expectedView.getBigUint64(1128,true)+1n,true);
  assert.equal(vm.vm_bind_execution(rows,1,9n),0);
  assert.equal(vm.vm_run(port,9n,1),1n); assert.equal(vm.vm_completed(),1);
  assert.equal(vm.vm_source_retired(),1n);
  assert.deepEqual(data.slice(base,base+1256),expected,'complete hot/cold CPU publication');
}
for(let rank=1;rank<=512;++rank) {
  const coldEntry=0x400000n+BigInt(rank);
  assert.equal(query(1,coldEntry),1n); await publish(coldEntry);
  observeExecution(coldEntry,3n); ++coldDemands;
  assert.equal(query(),0n,'hot C source survives distributed traffic at the unchanged banked quota');
  assert.equal(view.getUint32(rows+16,true),hotSlot);
  observeExecution(0x400000n,2n); ++hotDemands;
}
for (let i = 0; i < vm.vm_source_capacity(); ++i) table.set(firstSlot+i,null);
cc.compiler_close(); vm.vm_close();
console.log(`C source admission: green (${emitted} real cold emissions, ${coldDemands} cold + ${hotDemands} hot complete CPU dispatch comparisons; single/two-page reuse, demand-only tails, non-contiguous owners, exact writes including both CMPXCHG arms/LOCK, SETcc truth values, signed BT/BTS and ordered POP source aliases, pinned cancellation including A-bit table alias, stale, NX/nonpresent/residency, remap, grow/rebind and private table-slot regression; NOT Linux boot)`);
