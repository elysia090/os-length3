// Actual C-Wasm source admission and physical write observation. This is a
// boundary regression, not a Linux boot or a cryptographic module proof.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const [vmFile,compilerFile] = process.argv.slice(2);
if (!compilerFile) throw new Error('usage: check-source-admission.mjs VM.WASM COMPILER.WASM');
const memory = new WebAssembly.Memory({initial:8,maximum:16});
const provider = await WebAssembly.compile(await readFile(vmFile));
assert.deepEqual(WebAssembly.Module.imports(provider),[{module:'machine',name:'memory',kind:'memory'}]);
const vm = (await WebAssembly.instantiate(provider,{machine:{memory}})).exports;
const coldMemory = new WebAssembly.Memory({initial:16});
const cc = (await WebAssembly.instantiate(await readFile(compilerFile),{machine:{memory:coldMemory}})).instance.exports;
const cold = new Uint8Array(coldMemory.buffer), report = new DataView(coldMemory.buffer);
let data = new Uint8Array(memory.buffer), view = new DataView(memory.buffer);
const directory = vm.vm_arena_min(), rows = directory + 1024, branches = directory + 2048, base = directory + 4096;
const port = base + 2048, segments = base + 1408, codeView = base + 2112;
const code = base + 24576, firstSlot = vm.vm_slot_min(), table = vm.__indirect_function_table;
table.grow(Math.max(0,firstSlot + vm.vm_source_capacity() - table.length));
data.fill(0,directory);
function put(at,value) { view.setBigUint64(at,BigInt(value),true); }
for (let i = 0; i < 6; ++i) {
  const row = directory + i * 32;
  put(row,i < 4 ? (i+1)*4096 : (i+4)*4096);
  view.setUint32(row + 8,(i+2)*4096,true); view.setUint32(row + 12,3,true);
  view.setUint32(row + 16,1,true);
}
put(base + 8192,0x2007); put(base + 12288,0x3007);
put(base + 16384 + 16,0x4007); put(base + 20480,0x8007); put(base + 20488,0x9007);
put(port,9); put(base + 384,0x400000); put(base + 392,3);
put(base + 400,0x80010001); put(base + 408,0x1000); put(base + 416,32); put(base + 424,0xd00);
put(base + 488,16); put(base + 504,24);
view.setUint32(segments,1,true); view.setUint32(segments + 36,0xa09b,true);
data[code] = 0x90;
assert.equal(vm.vm_open(base,memory.buffer.byteLength-base,4096,directory,6,6,branches,9n),0);
assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
let emitted = 0;
function query(limit = 1) { return vm.vm_source_query(port,0x400000n,limit,codeView,rows); }
async function publish() {
  const slot = view.getUint32(rows + 16,true), offset = view.getUint32(codeView + 16,true);
  assert(slot >= firstSlot && slot < firstSlot + vm.vm_source_capacity());
  const input = cc.compiler_arena_min(), output = input + 4096, receipt = output + 65536;
  cold.set(data.subarray(offset,offset + 4096),input);
  assert.equal(cc.compiler_open_pages(input,1,0x400000n,9n),0);
  assert.equal(cc.compiler_emit(0x400000n,1,output,65536,receipt),0);
  const length = Number(report.getBigUint64(receipt + 40,true));
  const instance = await WebAssembly.instantiate(cold.slice(output,output+length),{machine:{memory}});
  table.set(slot,instance.instance.exports.cut);
  assert.equal(vm.vm_source_publish(Number(report.getBigUint64(receipt + 32,true)),
    Number(report.getBigUint64(receipt + 24,true)),rows),0); ++emitted;
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
assert.equal(vm.vm_source_publish(1,1,rows),-1); // Unknown compile span was pinned page-wide.
assert.equal(query(),1n); await publish();
assert.equal(vm.vm_access(port,0x400000n,1,2,0xf8n),0n);
assert.equal(query(),1n); await publish(); run();
assert.equal(view.getBigUint64(base + 392,true),2n); // Newly compiled CLC, not stale NOP.
assert.equal(query(),0n);
assert.equal(vm.vm_reserve(port,0x400000n,1,3),0n);
assert.equal(vm.vm_commit(port,0x90n),0n);
assert.equal(query(),1n); await publish();
// Permission must be checked before a cache hit, even in this intentionally
// hostile fixture with an unannounced supervisor PTE change.
const leaf = base + 20480, previous = view.getBigUint64(leaf,true);
put(leaf,previous | (1n << 63n));
data.fill(0xa5,codeView,codeView + 24); data.fill(0xa5,rows,rows + 24);
assert.equal(query(),115n); assert.equal(view.getUint32(port + 28,true),17);
assert(data.subarray(codeView,codeView+24).every(x => x === 0xa5));
assert(data.subarray(rows,rows+24).every(x => x === 0xa5));
put(leaf,previous); assert.equal(vm.vm_sources_reset(),0);
assert.equal(query(),1n); await publish(); assert.equal(query(),0n);
memory.grow(1); data = new Uint8Array(memory.buffer); view = new DataView(memory.buffer);
assert.equal(vm.vm_grow(),0); assert.equal(query(),0n);
put(port,8); assert.equal(query(),5n); put(port,9);
assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
assert.equal(query(),1n); await publish(); run();
for (let i = 0; i < vm.vm_source_capacity(); ++i) table.set(firstSlot+i,null);
cc.compiler_close(); vm.vm_close();
console.log(`C source admission: green (${emitted} real cold emissions; reuse, exact writes, reservation, stale, NX, grow/rebind and private table-slot regression; NOT Linux boot)`);
