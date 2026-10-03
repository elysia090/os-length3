// Execute generated cuts through the actual C-Wasm provider. Native records
// are the oracle; JavaScript sets up inputs, not guest access semantics.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {seedNativeSelector} from './selector-observation.mjs';

const [providerFile, directory] = process.argv.slice(2);
if (!providerFile || !directory)
  throw new Error('usage: node check-wasm-provider.mjs VM.WASM NATIVE-RECORD-DIRECTORY');
const provider = await WebAssembly.compile(await readFile(providerFile));
assert.deepEqual(WebAssembly.Module.imports(provider), [
  { module: 'machine', name: 'memory', kind: 'memory' },
]);
const names = (await readdir(directory)).filter(name => /^memory-\d+\.json$/.test(name)).sort();
assert(names.length > 0);
let comparisons = 0, hardwareFaults = 0, resumeFlagChecks = 0, selectorModels = 0;
for (const name of names) {
  const prefix = path.join(directory, name.slice(0, -5));
  const meta = JSON.parse(await readFile(`${prefix}.json`, 'utf8'));
  const module = await WebAssembly.compile(await readFile(`${prefix}.wasm`));
  const memory = new WebAssembly.Memory({ initial: 8, maximum: 16 });
  const vm = (await WebAssembly.instantiate(provider, { machine: { memory } })).exports;
  const instance = await WebAssembly.instantiate(module, {
    machine: { memory, access: vm.vm_access, reserve: vm.vm_reserve, commit: vm.vm_commit },
  });
  const directoryOffset = vm.vm_arena_min(), base = directoryOffset + 4096;
  const state = base, port = base + 2048, firstPage = base + 28672, nextPage = base + 40960;
  const cases = await readFile(`${prefix}.cases`);
  assert.equal(cases.length, 512 * 38 * 8);
  const records = new DataView(cases.buffer, cases.byteOffset, cases.byteLength);
  const faultRecords = await readFile(`${prefix}.faults`).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (faultRecords) assert.equal(faultRecords.length,512 * 38 * 8);
  function page(view, rank, address, offset, rights = 3, kind = 1, error = 0) {
    const at = directoryOffset + rank * 32;
    view.setBigUint64(at, address, true);
    view.setUint32(at + 8, offset, true); view.setUint32(at + 12, rights, true);
    view.setUint32(at + 16, kind, true); view.setUint32(at + 20, kind === 2 ? 14 : 0, true);
    view.setUint32(at + 24, error, true); view.setUint32(at + 28, 0, true);
  }
  function open() {
    assert.equal(vm.vm_open(base,memory.buffer.byteLength - base,4096,directoryOffset,6,6,directoryOffset + 1024,9n), 0);
    assert.equal(vm.vm_bind_state(state), 0);
  }
  function tables(view, address) {
    for (let level = 0; level < 4; ++level) {
      page(view, level, BigInt((level + 1) * 4096), (level + 2) * 4096);
      new Uint8Array(memory.buffer, base + (level + 2) * 4096, 4096).fill(0);
    }
    page(view, 4, 0x8000n, firstPage - base); page(view, 5, 0x9000n, nextPage - base);
    const shifts = [39n, 30n, 21n, 12n];
    for (let level = 0; level < 4; ++level) {
      const at = base + (level + 2) * 4096 + Number((address >> shifts[level]) & 511n) * 8;
      view.setBigUint64(at, BigInt(level === 3 ? 0x8000 : (level + 2) * 4096) | 103n, true);
    }
    const leaf = base + 20480 + Number((address >> 12n) & 511n) * 8;
    // Records only span within one PT; the explicit split witness is similar.
    assert(Number((address >> 12n) & 511n) < 511);
    view.setBigUint64(leaf + 8, 0x9067n, true);
    view.setBigUint64(state + 400, 0x80010001n, true);
    view.setBigUint64(state + 408, 0x1000n, true);
    view.setBigUint64(state + 416, 32n, true);
    view.setBigUint64(state + 424, 0xd00n, true);
    view.setBigUint64(state + 432 + 7 * 8, 0x10n, true);
    return leaf;
  }
  function arena() { return Buffer.from(memory.buffer, base); }
  function payloadAt(address, rank) {
    const offset = Number(address & 4095n) + rank;
    return offset < 4096 ? firstPage + offset : nextPage + offset - 4096;
  }
  for (let row = 0; row < 512; ++row) {
    if (row === 256) memory.grow(1);
    arena().fill(0xa5);
    const view = new DataView(memory.buffer);
    const word = rank => records.getBigUint64((row * 38 + rank) * 8, true);
    for (let reg = 0; reg < 16; ++reg) view.setBigUint64(state + reg * 8, word(reg), true);
    view.setBigUint64(state + meta.ripOffset, BigInt(meta.entry), true);
    view.setBigUint64(state + meta.flagsOffset, word(16), true);
    view.setBigUint64(state + meta.retiredOffset, 42n, true);
    view.setBigUint64(port, 9n, true);
    const address = word(35), leaf = tables(view, address);
    seedNativeSelector(view, state, meta);
    for (let i = 0; i < 8; ++i)
      view.setUint8(payloadAt(address, i), Number((word(36) >> BigInt(i * 8)) & 255n));
    open();
    const initial = Buffer.from(arena()), expected = Buffer.from(initial);
    const expectedView = new DataView(expected.buffer, expected.byteOffset, expected.byteLength);
    for (let reg = 0; reg < 16; ++reg) expectedView.setBigUint64(reg * 8, word(17 + reg), true);
    expectedView.setBigUint64(meta.ripOffset, word(34), true);
    expectedView.setBigUint64(meta.flagsOffset, word(33), true);
    expectedView.setBigUint64(meta.retiredOffset, 43n, true);
    if (meta.access & 2) {
      for (let i = 0; i < meta.bytes; ++i)
        expected[payloadAt(address, i) - base] = Number((word(37) >> BigInt(i * 8)) & 255n);
    }
    if (meta.access & 1) {
      expectedView.setBigUint64(port - base + 8,
        word(36) & ((1n << BigInt(meta.bytes * 8)) - 1n), true);
    }
    const savedDirectory = Buffer.from(memory.buffer, directoryOffset, 192).slice();
    assert.equal(instance.exports.cut(state, port), 1n);
    assert.deepEqual(arena(), expected, `${name}: native/C-Wasm row ${row}`);
    assert.deepEqual(Buffer.from(memory.buffer, directoryOffset, 192), savedDirectory);
    ++comparisons;

    if (meta.selector?.enabled) {
      // Change the guest's selector, not the oracle process's descriptor.
      // The instruction reads its low 16 visible bits without a GDT/LDT
      // lookup, and writes exactly two payload bytes even with REX.W.
      arena().set(initial);
      const selectorOffset = meta.selector.offset + meta.selector.rank * 8;
      const selector = BigInt(row < 16 ? row : (row * 65521) & 65535);
      view.setBigUint64(state + selectorOffset, 0xdead000000000000n | selector, true);
      const model = Buffer.from(arena());
      const m = new DataView(model.buffer, model.byteOffset, model.byteLength);
      m.setBigUint64(meta.ripOffset, word(34), true);
      m.setBigUint64(meta.flagsOffset, word(33), true);
      m.setBigUint64(meta.retiredOffset, 43n, true);
      for (let i = 0; i < 2; ++i)
        model[payloadAt(address, i) - base] = Number((selector >> BigInt(i * 8)) & 255n);
      open();
      assert.equal(instance.exports.cut(state, port), 1n);
      assert.deepEqual(arena(), model, `${name}: visible guest selector model ${row}`);
      ++selectorModels;
    }

    // RF is not settable by this native user-mode input harness. Independently
    // test the architectural successful-retirement rule with the real C MMU.
    arena().set(initial); view.setBigUint64(state + meta.flagsOffset,word(16) | 0x10000n,true);
    open();
    assert.equal(instance.exports.cut(state,port),1n);
    assert.deepEqual(arena(),expected,`${name}: successful access clears RF, row ${row}`);
    ++resumeFlagChecks;

    arena().set(initial); view.setBigUint64(port, 8n, true);
    const stale = Buffer.from(arena());
    assert.equal(instance.exports.cut(state, port), 5n);
    assert.deepEqual(arena(), stale, 'old generation must not mutate RAM or retire');
    arena().set(initial); vm.vm_close();
    assert.equal(instance.exports.cut(state, port), 6n);
    assert.deepEqual(arena(), initial, 'closed provider cannot keep old mappings');
    page(view, 4, 0x8000n, 0, 3, 3); open();
    assert.equal(instance.exports.cut(state, port), 2n);
    const pending = Buffer.from(initial);
    const pendingView = new DataView(pending.buffer, pending.byteOffset, pending.byteLength);
    pendingView.setBigUint64(port - base + 32, 0x8000n + (address & 4095n), true);
    pendingView.setUint32(port - base + 40, Math.min(meta.bytes, 4096 - Number(address & 4095n)), true);
    pendingView.setUint32(port - base + 44, (meta.access & 3) | 16, true);
    assert.deepEqual(arena(), pending, 'only complete pending-request metadata changes');
    arena().set(initial);
    page(view, 4, 0x8000n, firstPage - base); view.setBigUint64(leaf, 0n, true); open();
    assert.equal(instance.exports.cut(state, port), (14n << 3n) | 3n);
    const fault = Buffer.from(initial);
    const faultView = new DataView(fault.buffer, fault.byteOffset, fault.byteLength);
    faultView.setBigUint64(port - base + 16, address, true);
    faultView.setUint32(port - base + 24, 14, true);
    faultView.setUint32(port - base + 28, (meta.access & 2)
      | (meta.selector?.enabled && meta.selector.rank === 1 ? 4 : 0), true);
    faultView.setBigUint64(leaf - base, 0n, true);
    assert.deepEqual(arena(), fault, 'fault must not commit CPU or payload');
    if (faultRecords) {
      arena().set(initial); tables(view,address);
      const observed = rank => faultRecords.readBigUInt64LE((row * 38 + rank) * 8);
      for (let reg = 0; reg < 16; ++reg) view.setBigUint64(state + reg * 8,observed(reg),true);
      view.setBigUint64(state + meta.flagsOffset,observed(16),true);
      view.setBigUint64(state + 432 + 7 * 8,0x13n,true); // Same user-mode #PF bits as hardware.
      const failedLeaf = leaf + Number((observed(35) >> 12n) - (address >> 12n)) * 8;
      view.setBigUint64(failedLeaf,observed(37) & 1n ? 0x8063n : 0n,true);
      open();
      const expectedFault = Buffer.from(arena());
      const e = new DataView(expectedFault.buffer,expectedFault.byteOffset,expectedFault.byteLength);
      for (let reg = 0; reg < 16; ++reg) e.setBigUint64(reg * 8,observed(17 + reg),true);
      // RF is added by hardware fault entry, not by this pending-fault boundary.
      e.setBigUint64(meta.flagsOffset,observed(33) & ~0x10000n,true);
      e.setBigUint64(meta.ripOffset,observed(34),true);
      e.setBigUint64(port - base + 16,observed(35),true);
      e.setUint32(port - base + 24,Number(observed(36)),true);
      e.setUint32(port - base + 28,Number(observed(37)),true);
      assert.equal(instance.exports.cut(state,port),(observed(36) << 3n) | 3n,`${name}: native protection row ${row}`);
      assert.deepEqual(arena(),expectedFault,`${name}: native CMOV fault preserves CPU regardless of condition`);
      ++hardwareFaults;

      // A pending architectural fault must retain the incoming RF. Hardware
      // fault entry adds RF to its saved frame; this component does not enter it.
      arena().set(expectedFault);
      view.setBigUint64(state + meta.flagsOffset,observed(16) | 0x10000n,true);
      open();
      const rfFault=Buffer.from(arena());
      assert.equal(instance.exports.cut(state,port),(observed(36) << 3n) | 3n);
      assert.deepEqual(arena(),rfFault,`${name}: failed access preserves RF, row ${row}`);
      ++resumeFlagChecks;
    }
  }
  // Force a split write into noncontiguous resident pages, then a second-page
  // fault. The C boundary must preflight both pages before the first byte.
  const view = new DataView(memory.buffer), address = 0x123456789ffdn;
  const leaf = tables(view, address);
  view.setBigUint64(port, 9n, true); open();
  assert.equal(vm.vm_access(port, address, 8, 2, 0x8877665544332211n), 0n);
  assert.equal(vm.vm_access(port, address, 8, 1, 0n), 0n);
  assert.equal(view.getBigUint64(port + 8, true), 0x8877665544332211n);
  view.setBigUint64(leaf + 8, 0x9065n, true); open();
  const before = Buffer.from(arena());
  assert.equal(vm.vm_access(port, address, 8, 2, 0n), 115n);
  before.set(arena().subarray(port - base + 16, port - base + 32), port - base + 16);
  assert.deepEqual(arena(), before);
  assert.equal(view.getBigUint64(port + 16, true), (address & ~4095n) + 4096n);
  if (meta.returning) {
    tables(view, address); view.setBigUint64(port, 9n, true);
    view.setBigUint64(state + 32, address, true);
    view.setBigUint64(state + meta.ripOffset, BigInt(meta.entry), true);
    view.setBigUint64(state + meta.flagsOffset, 0x202n, true);
    view.setBigUint64(state + meta.retiredOffset, 42n, true);
    for (let i = 0; i < 8; ++i)
      view.setUint8(payloadAt(address, i), Number((0x800000000000n >> BigInt(i * 8)) & 255n));
    open();
    const expected = Buffer.from(arena()), expectedView = new DataView(expected.buffer, expected.byteOffset, expected.byteLength);
    expectedView.setBigUint64(port - base + 8, 0x800000000000n, true);
    expectedView.setBigUint64(port - base + 16, 0x800000000000n, true);
    expectedView.setUint32(port - base + 24, 13, true);
    expectedView.setUint32(port - base + 28, 0, true);
    assert.equal(instance.exports.cut(state, port), 107n);
    assert.deepEqual(arena(), expected, 'noncanonical RET faults before RSP/RIP/retirement commit');
  }
  // C stack/static data and descriptor rows are outside guest-addressable RAM.
  assert.equal(vm.vm_access(directoryOffset, address, 8, 2, 0n), 6n);
  assert.equal(vm.vm_open(base,memory.buffer.byteLength,4096,directoryOffset,6,6,directoryOffset + 1024,9n), -1);
  assert.equal(vm.vm_access(port, address, 8, 1, 0n), 6n);
}
console.log(`Generated cuts -> C vm.wasm/MMU/native: green (${names.length} modules, ${comparisons} comparisons, ${hardwareFaults} actual protection-fault comparisons, ${resumeFlagChecks} RF checks, ${selectorModels} guest selector models; exception entry/dispatch/Linux boot not tested)`);
