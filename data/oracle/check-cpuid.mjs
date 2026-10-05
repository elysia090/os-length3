// Fixed release CPUID contract, NOT passthrough to the development host CPU.
// Literal reset table + architectural MSR controls are the independent oracle. The program
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
  for (const leaf of leaves) for (const subleaf of subleaves) for (let controls = 0; controls < 8; ++controls)
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
    const flags = 2n | (random() & 0xed5n) | (sample & 1 ? 0x10000n : 0n);
    view.setBigUint64(base + 384,entry,true); view.setBigUint64(base + 392,flags,true);
    view.setBigUint64(base + 400,0x80010001n,true); view.setBigUint64(base + 408,0x1000n,true);
    view.setBigUint64(base + 416,32n,true); view.setBigUint64(base + 424,controls & 4 ? 0x500n : 0xd00n,true);
    if (controls) {
      view.setUint32(base + 608,2,true); view.setBigUint64(base + 616,0xc0000102n,true);
      view.setBigUint64(base + 624,0x1a0n,true);
      view.setBigUint64(base + 872,0xffff800012340000n,true);
      view.setBigUint64(base + 880,0x1800n|BigInt(controls & 1)
        | (controls & 2 ? 1n << 22n : 0n) | (controls & 4 ? 1n << 34n : 0n),true);
      if (sample===3) {
        const count=3+(leaf&3); view.setUint32(base+608,count,true);
        const values=[0x0023001000000000n,0xffff800012340000n,0x800000000000n,0x257fd5n];
        for (let i=2;i<count;++i) {
          view.setBigUint64(base+616+i*8,BigInt(0xc0000081+i-2),true);
          view.setBigUint64(base+872+i*8,values[i-2],true);
        }
      }
    } else if (sample & 2) {
      view.setUint32(base + 608,1,true); view.setBigUint64(base + 616,0xc0000102n,true);
      view.setBigUint64(base + 872,0xffff800012340000n,true);
      // Uncounted rank 1 is not live. It must not change effective features.
      view.setBigUint64(base + 624,0xffffffffn,true); view.setBigUint64(base + 880,~0n & 0xffffffffffffffffn,true);
    } else {
      view.setBigUint64(base + 616,0xffffffffn,true); view.setBigUint64(base + 872,1n << 47n,true);
      view.setBigUint64(base + 624,0xffffffffn,true); view.setBigUint64(base + 880,0x400001801n,true);
    }
    view.setUint32(base + 612,0x1f80,true); // Do not conflate count's u32 load with adjacent MXCSR.
    view.setBigUint64(base + 488,16n | BigInt(cpl),true); view.setBigUint64(base + 1128,42n,true);
    view.setBigUint64(port,9n,true);
    const before = Buffer.from(data.subarray(base,base + 1256));
    const expected = Buffer.from(before), words = [...(literal.get(leaf) ?? [0,0,0,0])];
    if (leaf === 0 && controls & 2) words[0] = 2;
    if (leaf === 0x80000001 && controls & 4) words[2] &= ~(1 << 20);
    for (let reg = 0; reg < 4; ++reg) expected.writeBigUInt64LE(BigInt(words[reg]),reg * 8);
    expected.writeBigUInt64LE(entry + 2n,384); expected.writeBigUInt64LE(43n,1128);
    expected.writeBigUInt64LE(flags & ~0x10000n,392);
    // Direct generated function has no VM/JS operation imports and ignores
    // its port argument. Compare its COMPLETE CPU record with the table.
    assert.equal(cut(base,0,entry),1n);
    assert(data.subarray(base,base + 1256).equals(expected),`leaf ${leaf.toString(16)} controls ${controls} CPL ${cpl}`);
    data.set(before,base);
    assert.equal(vm.vm_open(base,data.length - base,4096,directoryAt,5,5,directoryAt + 1024,9n),0);
    assert.equal(vm.vm_bind_state(base),0);
    view.setBigUint64(rows,entry,true); view.setUint32(rows + 8,2,true);
    view.setUint32(rows + 12,1,true); view.setUint32(rows + 16,slot,true); view.setUint32(rows + 20,0,true);
    assert.equal(vm.vm_bind_execution(rows,1,9n),0);
    assert.equal(vm.vm_run(port,9n,1),1n); assert.equal(vm.vm_source_retired(),1n);
    assert(data.subarray(base,base + 1256).equals(expected)); ++comparisons;
    for (const flag of [0x100n]) {
      data.set(before,base); view.setBigUint64(base + 392,flags | flag,true);
      const saved = Buffer.from(data.subarray(base,base + 1256));
      assert.equal(cut(base,0,entry),6n); assert(data.subarray(base,base + 1256).equals(saved)); ++rejected;
    }
  }
  // A corrupt persisted owner layout must not be interpreted as valid CPU
  // controls. Clear TF so this actually tests the bank guard, not flag refusal.
  const data = Buffer.from(memory.buffer), view = new DataView(memory.buffer);
  for (const corruption of ['count','owner0','owner1','canonical','reserved','status','NXE']) {
    view.setBigUint64(base + 384,entry,true); view.setBigUint64(base + 392,0x202n,true);
    view.setBigUint64(base + 424,0x500n,true); view.setUint32(base + 608,2,true);
    view.setBigUint64(base + 616,0xc0000102n,true); view.setBigUint64(base + 624,0x1a0n,true);
    view.setBigUint64(base + 872,0n,true); view.setBigUint64(base + 880,0x1801n,true);
    if (corruption === 'count') view.setUint32(base + 608,33,true);
    if (corruption === 'owner0') view.setBigUint64(base + 616,0x1a0n,true);
    if (corruption === 'owner1') view.setBigUint64(base + 624,0xc0000102n,true);
    if (corruption === 'canonical') view.setBigUint64(base + 872,1n << 47n,true);
    if (corruption === 'reserved') view.setBigUint64(base + 880,0x1803n,true);
    if (corruption === 'status') view.setBigUint64(base + 880,1n,true);
    if (corruption === 'NXE') {
      view.setBigUint64(base + 880,0x400001801n,true); view.setBigUint64(base + 424,0xd00n,true);
    }
    const before = Buffer.from(data.subarray(base,base + 1256));
    assert.equal(cut(base,0,entry),6n,corruption); assert(data.subarray(base,base + 1256).equals(before)); ++rejected;
  }
  // The new syscall ranks must have the same resume invariant in generated
  // CPUID and the C MSR owner. CSTAR's unused full-width value is admissible.
  for (const corruption of ['owner2','owner3','owner4','owner5','STAR','LSTAR','FMASK']) {
    view.setBigUint64(base+392,0x202n,true); view.setBigUint64(base+424,0x500n,true);
    view.setUint32(base+608,6,true);
    for (let i=0;i<6;++i) {
      view.setBigUint64(base+616+i*8,BigInt(i===0 ? 0xc0000102 : i===1 ? 0x1a0 : 0xc0000081+i-2),true);
      view.setBigUint64(base+872+i*8,i===1 ? 0x1801n : 0n,true);
    }
    if (corruption.startsWith('owner')) view.setBigUint64(base+616+Number(corruption[5])*8,0n,true);
    if (corruption==='STAR') view.setBigUint64(base+888,1n,true);
    if (corruption==='LSTAR') view.setBigUint64(base+896,1n<<47n,true);
    if (corruption==='FMASK') view.setBigUint64(base+912,1n<<32n,true);
    const before=Buffer.from(data.subarray(base,base+1256));
    assert.equal(cut(base,0,entry),6n,corruption); assert(data.subarray(base,base+1256).equals(before));
    ++rejected;
  }
} finally { vm.__indirect_function_table.set(slot,null); vm.vm_close(); }
console.log(`Fixed-profile CPUID: green (${comparisons} complete CPU comparisons direct+C dispatcher including RF retirement, ${rejected} TF/bank refusals; NOT host CPUID/hardware privileged oracle/Linux boot)`);
