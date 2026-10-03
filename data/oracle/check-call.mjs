// Hardware CALL receipts -> cold C byte parity -> actual C-Wasm VM/MMU.
// The host copies test state; it never interprets guest instructions.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
const [providerFile, compilerFile, directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: check-call.mjs VM.WASM COMPILER.WASM CALL-FIXTURE-DIRECTORY');
const memory = new WebAssembly.Memory({initial:8, maximum:16});
const vm = (await WebAssembly.instantiate(await readFile(providerFile), {machine:{memory}})).instance.exports;
const coldMemory = new WebAssembly.Memory({initial:16, maximum:32});
const compilerModule = await WebAssembly.compile(await readFile(compilerFile));
assert.deepEqual(WebAssembly.Module.imports(compilerModule), [{module:'machine', name:'memory', kind:'memory'}]);
const cc = (await WebAssembly.instantiate(compilerModule, {machine:{memory:coldMemory}})).exports;
const cold = Buffer.from(coldMemory.buffer), cv = new DataView(coldMemory.buffer);
const input = cc.compiler_arena_min(), output = input + 8192, report = output + 65536;
const data = Buffer.from(memory.buffer), view = new DataView(memory.buffer);
const directoryAt = vm.vm_arena_min(), rows = directoryAt + 512, base = directoryAt + 4096;
const port = base + 2048, segments = base + 1408, codeView = base + 2112;
const code = base + 28672, ram = base + 32768, ramPte = base + 24576 + 320 * 8;
const entry = 0x400000n, start = 0x12340000n, stride = 44 * 8;
const slot = vm.__indirect_function_table.grow(1);
let comparisons = 0, faults = 0, retainedStores = 0, parity = 0, refusals = 0, boundaries = 0, rf = 0;
const u64 = (record, rank) => record.readBigUInt64LE(rank * 8);
function offset(address) {
  if (address >= entry && address <= entry + 4096n - 8n) return code + Number(address - entry);
  if (address >= start && address <= start + 8192n - 8n) return ram + Number(address - start);
  return null;
}
function reset(source, bytes, record) {
  data.fill(0, base);
  for (const [first, end] of [[128,384],[432,488],[496,1128],[1136,1256]])
    data.fill(0x5a, base + first, base + end);
  const physical = [0x1000,0x2000,0x3000,0x4000,0x5000,0x8000,0x9000,0xa000];
  for (const [rank, address] of physical.entries()) {
    const at = directoryAt + rank * 32;
    view.setBigUint64(at, BigInt(address), true); view.setUint32(at + 8, (rank + 2) * 4096, true);
    view.setUint32(at + 12, 3, true); view.setUint32(at + 16, 1, true); data.fill(0, at + 20, at + 32);
  }
  view.setBigUint64(base + 8192, 0x2067n, true); view.setBigUint64(base + 12288, 0x3067n, true);
  view.setBigUint64(base + 16384 + 2 * 8, 0x4067n, true);
  view.setBigUint64(base + 16384 + 145 * 8, 0x5067n, true);
  view.setBigUint64(base + 20480, 0x8067n, true);
  view.setBigUint64(ramPte, 0x9067n, true); view.setBigUint64(ramPte + 8, 0xa067n, true);
  const phase = Number(u64(record,43));
  if (phase === 4 || phase === 6) view.setBigUint64(ramPte + 8, 0n, true);
  if (phase === 5) view.setBigUint64(ramPte + 8, 0xa065n, true);
  data.set(source, code); data.fill(0x5a, ram, ram + 8192);
  for (let rank = 0; rank < 17; ++rank) view.setBigUint64(base + (rank === 16 ? 392 : rank * 8), u64(record,rank), true);
  if (u64(record,37)) view.setBigUint64(offset(u64(record,37)), u64(record,38), true);
  const stack = offset(u64(record,39));
  if (stack !== null) view.setBigUint64(stack, u64(record,40), true);
  view.setBigUint64(base + 384, entry, true); view.setBigUint64(base + 1128, 42n, true);
  view.setBigUint64(base + 400, 0x80010011n, true); view.setBigUint64(base + 408, 0x1000n, true);
  view.setBigUint64(base + 416, 32n, true); view.setBigUint64(base + 424, 0xd00n, true);
  view.setBigUint64(base + 488, 19n, true); view.setBigUint64(port, 9n, true);
  view.setUint32(segments, 1, true); view.setUint32(segments + 36, 0xa0fb, true);
  assert.equal(vm.vm_open(base, data.length - base, 4096, directoryAt, 8, 8, directoryAt + 1024, 9n), 0);
  assert.equal(vm.vm_bind_state(base), 0); assert.equal(vm.vm_bind_segments(segments), 0);
  view.setBigUint64(rows, entry, true); view.setUint32(rows + 8, bytes, true);
  view.setUint32(rows + 12, 1, true); view.setUint32(rows + 16, slot, true); view.setUint32(rows + 20, 0, true);
  assert.equal(vm.vm_bind_execution(rows, 1, 9n), 0);
}
const cpu = () => Buffer.from(data.subarray(base, base + 1256));
const payload = () => Buffer.from(data.subarray(code, ram + 8192));
function unchanged(before, bytes) {
  assert(data.subarray(base, base + 1256).equals(before), 'complete CPU unchanged');
  assert(data.subarray(code, ram + 8192).equals(bytes), 'payload unchanged');
  assert.equal(vm.vm_completed(), 0); assert.equal(vm.vm_source_retired(), 0n);
}
try {
  for (let form = 0; form < 27; ++form) {
    const prefix = path.join(directory, `call-${form}`);
    const source = await readFile(`${prefix}.source-page`), meta = JSON.parse(await readFile(`${prefix}.json`));
    const emitted = await readFile(`${prefix}.wasm`), native = await readFile(`${prefix}.cases`);
    cold.set(source, input); assert.equal(cc.compiler_open_pages(input, 1, entry, 9n), 0);
    assert.equal(cc.compiler_emit(entry, 1, output, 65536, report), 0);
    assert.equal(cv.getBigUint64(report + 40, true), BigInt(emitted.length));
    assert(cold.subarray(output, output + emitted.length).equals(emitted), 'native/cold byte-identical'); ++parity;
    const module = await WebAssembly.compile(emitted);
    assert.deepEqual(WebAssembly.Module.imports(module), [
      {module:'machine', name:'memory', kind:'memory'}, {module:'machine', name:'access', kind:'function'}]);
    const cut = (await WebAssembly.instantiate(module, {machine:{memory, access:vm.vm_access}})).exports.cut;
    vm.__indirect_function_table.set(slot, cut);
    assert.equal(native.length, 256 * stride);
    for (let row = 0; row < 256; ++row) {
      const record = native.subarray(row * stride, (row + 1) * stride), vector = u64(record,35);
      reset(source, meta.sourceBytes, record);
      const expected = cpu(), bytes = payload();
      for (let rank = 0; rank < 16; ++rank) expected.writeBigUInt64LE(u64(record,17 + rank), rank * 8);
      expected.writeBigUInt64LE(u64(record,33), 392); expected.writeBigUInt64LE(u64(record,34), 384);
      if (!vector) expected.writeBigUInt64LE(43n, 1128);
      const stack = offset(u64(record,39));
      if (stack !== null) bytes.writeBigUInt64LE(u64(record,41), stack - code);
      assert.equal(vm.vm_run(port, 9n, 1), vector ? (vector << 3n) | 3n : 5n, `${form}/${row}: result`);
      assert(data.subarray(base, base + 1256).equals(expected), `${form}/${row}: actual x86 CPU`);
      assert(data.subarray(code, ram + 8192).equals(bytes), `${form}/${row}: actual x86 stack payload`);
      assert.equal(vm.vm_completed(), vector ? 0 : 1); assert.equal(vm.vm_source_retired(), vector ? 0n : 1n);
      if (vector) {
        assert.equal(view.getUint32(port + 24, true), Number(vector), `${form}/${row}: vector`);
        assert.equal(view.getUint32(port + 28, true), Number(u64(record,36)), `${form}/${row}: fault error`);
        assert.equal(view.getBigUint64(port + 16, true), u64(record,42), `${form}/${row}: fault address`);
        ++faults; if (vector === 13n) ++retainedStores;
      }
      ++comparisons;
      reset(source,meta.sourceBytes,record);
      view.setBigUint64(base+392,u64(record,16)|0x10000n,true);
      const rfExpected = Buffer.from(expected);
      if (vector) rfExpected.writeBigUInt64LE(u64(record,16)|0x10000n,392);
      assert.equal(cut(base,port),vector ? vector<<3n|3n : 1n);
      assert(data.subarray(base,base+1256).equals(rfExpected)); assert(data.subarray(code,ram+8192).equals(bytes)); ++rf;
    }
    const record = native.subarray(0, stride);
    for (const failure of ['TF','AC','alias','wrap','stale']) {
      reset(source, meta.sourceBytes, record);
      if (failure === 'TF' || failure === 'AC')
        view.setBigUint64(base + 392, 0x202n | ({TF:256n, AC:262144n}[failure]), true);
      if (failure === 'stale') view.setBigUint64(port, 8n, true);
      const before = cpu(), bytes = payload();
      assert.equal(failure === 'stale' ? vm.vm_run(port, 9n, 1)
        : cut(base, failure === 'alias' ? base : failure === 'wrap' ? 0xfffffff8 : port), failure === 'stale' ? 5n : 6n);
      unchanged(before, bytes); ++refusals;
    }
    if (form === 0) {
      reset(source, meta.sourceBytes, record); view.setBigUint64(base, 0x600000n, true);
      assert.equal(vm.vm_run(port, 9n, 1), 5n); assert.equal(vm.vm_completed(), 1); assert.equal(vm.vm_source_retired(), 1n);
      const before = cpu(); assert.equal(before.readBigUInt64LE(384), 0x600000n);
      assert.equal(vm.vm_code(port, 0x600000n, codeView), 115n);
      assert(data.subarray(base, base + 1256).equals(before));
      assert.equal(view.getUint32(port + 28, true), 20); ++boundaries;
      // Physical residency is not a guest #PF. The target was read, but no
      // stack store/CPU publication occurs until every stack fragment exists.
      reset(source, meta.sourceBytes, record); view.setBigUint64(ramPte + 8, 0xb067n, true);
      const state = cpu(), bytes = payload(); assert.equal(vm.vm_run(port, 9n, 1), 2n);
      unchanged(state, bytes); assert.equal(view.getBigUint64(port + 32, true), 0xb000n); ++boundaries;
    }
  }
} finally { vm.__indirect_function_table.set(slot, null); vm.vm_close(); cc.compiler_close(); }
console.log(`Indirect CALL: green (${parity} native/cold identical modules; ${comparisons} actual x86 CPU/stack cases, ${faults} exception frames, ${retainedStores} #GP-retained stores, ${refusals} refusals, ${boundaries} fetch/residency cases, ${rf} RF checks; NOT exception delivery/Linux boot)`);
