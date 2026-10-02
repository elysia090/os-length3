// Fixed release CPUID contract, NOT passthrough to the development host CPU.
// Literal public table is the independent specification oracle. The program
// under test is emitted C-Wasm and the actual C table/MMU dispatcher.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [providerFile,directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-cpuid.mjs VM.WASM CODE-FIXTURE-DIRECTORY');
const module = await WebAssembly.compile(await readFile(path.join(directory,'cpuid.wasm')));
assert.deepEqual(WebAssembly.Module.imports(module),[{module:'machine',name:'memory',kind:'memory'}]);
const provider = await WebAssembly.compile(await readFile(providerFile));
const memory = new WebAssembly.Memory({initial:8,maximum:16});
const vm = (await WebAssembly.instantiate(provider,{machine:{memory}})).exports;
const cut = (await WebAssembly.instantiate(module,{machine:{memory}})).exports.cut;
const input = vm.vm_arena_min(), rows = input, directoryAt = input + 4096, base = input + 8192;
const port = base + 2048, slot = vm.__indirect_function_table.grow(1);
vm.__indirect_function_table.set(slot,cut);
const source = await readFile(path.join(directory,'cpuid.source-page'));
const entry = 0x400000n;
const literal = new Map([
  [0,[7,0x6c65746e,0x49656e69,0x756e6547]],
  [1,[0x306a9,0x00982201,0x0780a179,0]],
  [0x80000000,[0x80000008,0,0,0]],
  [0x80000001,[0,1,0x20100800,0]],
  [0x80000008,[0x3028,0,0,0]],
]); // Machine register order: RAX, RCX, RDX, RBX.
const leaves = [...Array.from({length:32},(_,i) => i),
  ...Array.from({length:32},(_,i) => 0x80000000 + i),0xffffffff,0x7fffffff,0x12345678];
const subleaves = [0,1,2,7,31,0x80000000,0xffffffff];
let comparisons = 0, rejected = 0, seed = 0x123456789abcdefn;
function random() {
  seed = BigInt.asUintN(64,seed ^ (seed << 13n)); seed ^= seed >> 7n;
  seed = BigInt.asUintN(64,seed ^ (seed << 17n)); return seed;
}
try {
  for (const leaf of leaves) for (const subleaf of subleaves)
  for (let cpl = 0; cpl < 4; ++cpl) for (let sample = 0; sample < 4; ++sample) {
    const data = Buffer.from(memory.buffer), view = new DataView(memory.buffer);
    data.fill(0,base);
    for (let rank = 0; rank < 5; ++rank) {
      const at = directoryAt + rank * 32;
      view.setBigUint64(at,BigInt(rank < 4 ? (rank + 1) * 4096 : 0x8000),true);
      view.setUint32(at + 8,rank < 4 ? (rank + 2) * 4096 : 28672,true);
      view.setUint32(at + 12,3,true); view.setUint32(at + 16,1,true); data.fill(0,at + 20,at + 32);
      if (rank < 4) {
        const shifts = [39n,30n,21n,12n];
        const at = base + (rank + 2) * 4096 + Number((entry >> shifts[rank]) & 511n) * 8;
        view.setBigUint64(at,BigInt(rank === 3 ? 0x8000 : (rank + 2) * 4096) | 39n,true);
      }
    }
    data.set(source,base + 28672);
    for (let reg = 0; reg < 16; ++reg) view.setBigUint64(base + reg * 8,random(),true);
    view.setBigUint64(base,(random() & ~0xffffffffn) | BigInt(leaf),true);
    view.setBigUint64(base + 8,(random() & ~0xffffffffn) | BigInt(subleaf),true);
    const flags = 2n | (random() & 0xed5n);
    view.setBigUint64(base + 384,entry,true); view.setBigUint64(base + 392,flags,true);
    view.setBigUint64(base + 400,0x80010001n,true); view.setBigUint64(base + 408,0x1000n,true);
    view.setBigUint64(base + 416,32n,true); view.setBigUint64(base + 424,0xd00n,true);
    view.setBigUint64(base + 488,16n | BigInt(cpl),true); view.setBigUint64(base + 1128,42n,true);
    view.setBigUint64(port,9n,true);
    const before = Buffer.from(data.subarray(base,base + 1256));
    const expected = Buffer.from(before), words = literal.get(leaf) ?? [0,0,0,0];
    for (let reg = 0; reg < 4; ++reg) expected.writeBigUInt64LE(BigInt(words[reg]),reg * 8);
    expected.writeBigUInt64LE(entry + 2n,384); expected.writeBigUInt64LE(43n,1128);
    // Direct generated function has no VM/JS operation imports and ignores
    // its port argument. Compare its COMPLETE CPU record with the table.
    assert.equal(cut(base,0),1n); assert(data.subarray(base,base + 1256).equals(expected));
    data.set(before,base);
    assert.equal(vm.vm_open(base,data.length - base,4096,directoryAt,5,5,directoryAt + 1024,9n),0);
    assert.equal(vm.vm_bind_state(base),0);
    view.setBigUint64(rows,entry,true); view.setUint32(rows + 8,2,true);
    view.setUint32(rows + 12,1,true); view.setUint32(rows + 16,slot,true); view.setUint32(rows + 20,0,true);
    assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    assert.equal(vm.vm_run(port,9n,1),1n); assert.equal(vm.vm_source_retired(),1n);
    assert(data.subarray(base,base + 1256).equals(expected)); ++comparisons;
    for (const flag of [0x100n,0x10000n]) {
      data.set(before,base); view.setBigUint64(base + 392,flags | flag,true);
      const saved = Buffer.from(data.subarray(base,base + 1256));
      assert.equal(cut(base,0),6n); assert(data.subarray(base,base + 1256).equals(saved)); ++rejected;
    }
  }
} finally { vm.__indirect_function_table.set(slot,null); vm.vm_close(); }
console.log(`Fixed-profile CPUID: green (${comparisons} complete CPU comparisons direct+C dispatcher, ${rejected} TF/RF rejections; NOT host CPUID/hardware privileged oracle/Linux boot)`);
