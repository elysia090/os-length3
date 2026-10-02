// Admission export tests against the actual C-Wasm MMU, not a JS page walker.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const [file] = process.argv.slice(2);
if (!file) throw new Error('usage: check-code-view.mjs VM.WASM');
const module = await WebAssembly.compile(await readFile(file));
assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'}]);
const memory = new WebAssembly.Memory({initial:8,maximum:16});
const vm = (await WebAssembly.instantiate(module,{machine:{memory}})).exports;
const directory = vm.vm_arena_min(), base = directory + 4096;
const port = base + 2048, record = base + 2112, segments = base + 1408;
const address = 0x400011n, leaf = base + 20480;
let data, view, checks = 0;
function reset() {
  data = new Uint8Array(memory.buffer); view = new DataView(memory.buffer);
  data.fill(0,base);
  for (let rank = 0; rank < 5; ++rank) {
    const at = directory + rank * 32;
    view.setBigUint64(at,BigInt(rank < 4 ? (rank + 1) * 4096 : 0x8000),true);
    view.setUint32(at + 8,rank < 4 ? (rank + 2) * 4096 : 28672,true);
    view.setUint32(at + 12,3,true); view.setUint32(at + 16,1,true);
    data.fill(0,at + 20,at + 32);
    if (rank < 4) {
      const shifts = [39n,30n,21n,12n];
      const at = base + (rank + 2) * 4096 + Number((address >> shifts[rank]) & 511n) * 8;
      view.setBigUint64(at,BigInt(rank === 3 ? 0x8000 : (rank + 2) * 4096) | 7n,true);
    }
  }
  view.setBigUint64(base + 400,0x80010001n,true); view.setBigUint64(base + 408,0x1000n,true);
  view.setBigUint64(base + 416,32n,true); view.setBigUint64(base + 424,0xd00n,true);
  view.setBigUint64(base + 488,0x10n,true); view.setBigUint64(port,9n,true);
  view.setUint32(segments,1,true);
  view.setUint32(segments + 36,0xa09b,true);
  assert.equal(vm.vm_open(base,data.length - base,4096,directory,5,5,directory + 1024,9n),0);
  assert.equal(vm.vm_bind_state(base),0); assert.equal(vm.vm_bind_segments(segments),0);
  data.fill(0xa5,record,record + 24);
}
function reject(expected,entry = address,target = record) {
  const saved = data.slice(target < data.length ? target : record,
                          target < data.length ? target + 24 : record + 24);
  assert.equal(vm.vm_code(port,entry,target),expected); ++checks;
  assert.deepEqual(data.subarray(target < data.length ? target : record,
                                 target < data.length ? target + 24 : record + 24),saved);
}
reset();
assert.equal(vm.vm_code(port,address,record),0n); ++checks;
assert.equal(view.getBigUint64(record,true),0x400000n);
assert.equal(view.getBigUint64(record + 8,true),9n);
assert.equal(view.getUint32(record + 16,true),base + 28672);
assert.equal(view.getUint32(record + 20,true),4096);
assert.equal(view.getBigUint64(leaf,true) & 96n,32n);
// Fetch projection is not an execution grant.
assert.equal(vm.vm_run(port,9n,1),5n);
for (const target of [base,segments,port,record + 1,directory,base + 4080,0xfffffff8]) {
  reset(); reject(6n,address,target);
}
reset(); view.setBigUint64(port,8n,true); reject(5n);
reset(); view.setBigUint64(base + 416,32n | (1n << 12n),true); reject(6n);
for (const attributes of [0x809b,0xe09b,0x1a09b]) {
  reset(); view.setUint32(segments + 36,attributes,true); reject(6n);
}
reset(); reject(13n << 3n | 3n,0x800000000000n);
reset(); view.setBigUint64(leaf,view.getBigUint64(leaf,true) | (1n << 63n),true);
reject(14n << 3n | 3n);
assert.equal(view.getBigUint64(port + 16,true),address);
assert.equal(view.getUint32(port + 28,true),17);
for (const [rights,kind] of [[2,1],[3,3]]) {
  reset(); view.setUint32(directory + 4 * 32 + 12,rights,true);
  view.setUint32(directory + 4 * 32 + 16,kind,true);
  reject(2n); assert.equal(view.getBigUint64(port + 32,true),0x8011n);
  assert.equal(view.getUint32(port + 44,true),17);
}
// A mapping to its own page-table page exposes the post-A-bit source, not an
// earlier copied image. Its physical offset is still selected entirely in C.
reset(); view.setBigUint64(leaf,0x4007n,true);
assert.equal(vm.vm_code(port,address,record),0n); ++checks;
assert.equal(view.getUint32(record + 16,true),base + 20480);
assert.equal(view.getBigUint64(leaf,true),0x4027n);
memory.grow(1); reset(); assert.equal(vm.vm_code(port,address,record),0n); ++checks;
vm.vm_close(); reject(6n);
console.log(`C-MMU borrowed code view: green (${checks} export cases; no copy/JS translation/execution grant)`);
