// Actual shipped header/page -> C-Wasm boot projection and MMU fetch.
// Optional cold-compiled startup prefix executes real kernel instructions.
// Neither initial-page checks nor that short prefix certify a Linux boot.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const [providerFile, prefix, codePrefix] = process.argv.slice(2);
if (!providerFile || !prefix) throw new Error('usage: check-wasm-boot.mjs VM.WASM NATIVE-RECORD-PREFIX [COMPILED-STARTUP-PREFIX]');
const module = await WebAssembly.compile(await readFile(providerFile));
assert.deepEqual(WebAssembly.Module.imports(module), [
  { module: 'machine', name: 'memory', kind: 'memory' },
]);
const meta = JSON.parse(await readFile(`${prefix}.json`, 'utf8'));
const header = await readFile(`${prefix}.header`), command = await readFile(`${prefix}.command`);
const expectedState = await readFile(`${prefix}.state`), expectedPages = await readFile(`${prefix}.metadata`);
const expectedSegments = await readFile(`${prefix}.segments`);
const kernel = await readFile(`${prefix}.kernel-page`);
assert.equal(header.length, 4096); assert.equal(kernel.length, 4096);
assert.equal(expectedPages.length, 6 * 4096);
const memory = new WebAssembly.Memory({ initial: 8, maximum: 16 });
const vm = (await WebAssembly.instantiate(module, { machine: { memory } })).exports;
const input = vm.vm_arena_min(), base = input + 4 * 4096;
const output = input + 8192, directory = input + 12288, port = base + 2048;
const segments = base + 1408;
let view = new DataView(memory.buffer), data = Buffer.from(memory.buffer);
data.set(header, input); data.set(command, input + 4096);
function prepare() {
  return vm.vm_boot_prepare(input, header.length, BigInt(meta.imageBytes),
    BigInt(meta.initramfsBytes), BigInt(meta.ramBytes), input + 4096, command.length);
}
assert.equal(prepare(), 0);
for (let i = 0; i < 6; ++i) {
  const target = base + (i + 2) * 4096;
  assert.equal(vm.vm_boot_project(BigInt((i + 1) * 4096), target, output), 1);
  assert.deepEqual(data.subarray(target, target + 4096), expectedPages.subarray(i * 4096, (i + 1) * 4096));
}
assert.equal(vm.vm_boot_initial_state(base), 0);
assert.deepEqual(data.subarray(base, base + expectedState.length), expectedState);
assert.equal(vm.vm_boot_initial_segments(segments),0);
assert.deepEqual(data.subarray(segments,segments + expectedSegments.length),expectedSegments);
async function checkStartup() {
  if (!codePrefix) return;
  // The C cold compiler's output is tied to this opaque shipped code page,
  // not a synthetic ELF or a copied unshipped Kbuild image. No JS cut loop.
  assert.deepEqual(kernel.subarray(0x200, 0x204), Buffer.from([0xfc, 0xfa, 0x31, 0xc0]));
  const records = [];
  for (let i = 0; i < 32; ++i) {
    const name = i ? `${codePrefix}.${i}` : codePrefix;
    try { records.push({ name, record: JSON.parse(await readFile(`${name}.json`,'utf8')) }); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  assert.equal(records.length,11);
  const table = vm.__indirect_function_table, firstSlot = table.grow(records.length);
  assert(firstSlot >= vm.vm_slot_min());
  let next = BigInt(meta.entry), instructions = 0;
  const compiled = [];
  for (const [i, {name,record}] of records.entries()) {
    assert.equal(BigInt(record.entry), next);
    const bytes = await readFile(`${name}.wasm`);
    assert.equal(bytes.length, record.moduleBytes);
    const emitted = await WebAssembly.compile(bytes);
    const imports = [{ module: 'machine', name: 'memory', kind: 'memory' }];
    if (i >= 3 && i <= 7) imports.push({module:'machine',name:'segment',kind:'function'});
    if (i === 9) imports.push({module:'machine',name:'access',kind:'function'});
    assert.deepEqual(WebAssembly.Module.imports(emitted),imports);
    const instance = await WebAssembly.instantiate(emitted, { machine: { memory,segment:vm.vm_segment,access:vm.vm_access } });
    table.set(firstSlot + i, instance.exports.cut); compiled.push(instance.exports.cut);
    const row = output + i * 24;
    view.setBigUint64(row, next, true); view.setUint32(row + 8, record.sourceBytes, true);
    view.setUint32(row + 12, record.instructions, true); view.setUint32(row + 16, firstSlot + i, true);
    view.setUint32(row + 20, 0, true);
    next = BigInt(record.continuation); instructions += record.instructions;
  }
  assert.equal(instructions,14); assert.equal(next,BigInt(meta.entry) + 0x32n);
  assert.equal(vm.vm_bind_execution(output,records.length,9n),0);
  assert.equal(vm.vm_run(port,9n,32),6n,'next memory-ADD coordinate is not silently executed');
  assert.equal(vm.vm_completed(),11); assert.equal(vm.vm_source_retired(),14n);
  const expected = Buffer.from(expectedState);
  const relocated = 0x1000000n + BigInt(header.readUInt32LE(0x260)) - 0x320000n;
  expected.writeBigUInt64LE(0x1000000n,5 * 8); expected.writeBigUInt64LE(relocated,3 * 8);
  expected.writeBigUInt64LE(relocated + 0x2ea400n,4 * 8);
  // This is an independent fixture expectation, not an execution decoder.
  assert.deepEqual(kernel.subarray(0x22b,0x22e),Buffer.from([0x48,0x8d,0x05]));
  expected.writeBigUInt64LE(0x1000232n + BigInt(kernel.readInt32LE(0x22e)),0);
  for (const rank of [0,2,3,4,5]) expected.writeBigUInt64LE(0n,432 + (6 + rank) * 8);
  expected.writeBigUInt64LE(next,384); expected.writeBigUInt64LE(6n,392);
  expected.writeBigUInt64LE(14n,1128);
  assert.deepEqual(data.subarray(base,base + expected.length),expected,'real startup selector/GPR/flags/retirement state');
  const segmentResult = Buffer.from(expectedSegments);
  for (const rank of [0,2,3,4,5]) {
    segmentResult.fill(0,8 + rank * 16,8 + (rank + 1) * 16);
    segmentResult.writeUInt32LE(0x10000,8 + rank * 16 + 12);
  }
  assert.deepEqual(data.subarray(segments,segments + expectedSegments.length),segmentResult,'MOV SS shadow consumed after MOV FS');
  // Independent CLI specification matrix. CPL0 is not a native hardware
  // differential; exception delivery is outside this pending-fault test.
  const cli = compiled[1], cliEntry = BigInt(meta.entry) + 1n;
  for (let cpl = 0; cpl < 4; ++cpl) for (let iopl = 0; iopl < 4; ++iopl) {
    data.set(expectedState, base); data.fill(0, port, port + 48); view.setBigUint64(port, 9n, true);
    const flags = 0x80ad7n | BigInt(iopl << 12);
    view.setBigUint64(base + 384, cliEntry, true); view.setBigUint64(base + 392, flags, true);
    view.setBigUint64(base + 488, BigInt(0x10 | cpl), true);
    const savedState = data.subarray(base, base + expectedState.length).slice();
    const expectedCli = Buffer.from(savedState);
    if (cpl <= iopl) {
      assert.equal(cli(base, port), 1n);
      expectedCli.writeBigUInt64LE(flags & ~0x200n, 392);
      expectedCli.writeBigUInt64LE(cliEntry + 1n, 384); expectedCli.writeBigUInt64LE(1n, 1128);
    } else {
      assert.equal(cli(base, port), 107n);
      assert.equal(view.getBigUint64(port + 16, true), cliEntry);
      assert.equal(view.getUint32(port + 24, true), 13); assert.equal(view.getUint32(port + 28, true), 0);
    }
    assert.deepEqual(data.subarray(base, base + expectedState.length), expectedCli);
  }
  for (const [cr4, flags] of [[34n, 0x202n], [32n, 0x20202n]]) {
    data.set(expectedState, base); data.fill(0, port, port + 48);
    view.setBigUint64(base + 384, cliEntry, true); view.setBigUint64(base + 416, cr4, true);
    view.setBigUint64(base + 392, flags, true);
    const savedState = data.subarray(base, base + expectedState.length).slice();
    const savedPort = data.subarray(port, port + 48).slice();
    assert.equal(cli(base, port), 6n);
    assert.deepEqual(data.subarray(base, base + expectedState.length), savedState);
    assert.deepEqual(data.subarray(port, port + 48), savedPort);
  }
  data.set(expectedState, base); view.setBigUint64(port, 9n, true);
  data.set(expectedSegments,segments);
  assert.equal(vm.vm_bind_execution(output,records.length,9n),0);
  assert.equal(vm.vm_run(port, 9n, 1), 1n); assert.equal(vm.vm_completed(), 1);
  assert.equal(vm.vm_run(port, 9n, 2), 1n); assert.equal(vm.vm_completed(), 2);
  assert.equal(vm.vm_run(port,9n,32),6n); assert.equal(vm.vm_completed(),8);
  assert.deepEqual(data.subarray(base,base + expected.length),expected);
  // Host admission of companion state/port aliases must fail before any write.
  for (const badPort of [base,segments,segments + 128,port + 1]) {
    const snapshot = Buffer.from(data);
    assert.equal(vm.vm_segment(badPort,3,0),6n); assert.deepEqual(data,snapshot);
  }
  assert.equal(vm.vm_bind_segments(base),-1);
  assert.equal(vm.vm_segment(port,3,0),6n,'failed companion rebind revokes the old context');
  for (let i = 0; i < records.length; ++i) table.set(firstSlot + i,null);
  console.log(`Actual shipped kernel startup -> C dispatcher: 14 instructions retired; next RIP 0x${next.toString(16)} is a memory-ADD compile gate; Linux boot NOT achieved`);
}
let saved = Buffer.from(data);
assert.equal(vm.vm_boot_project(BigInt(meta.kernelAddress), base + 8 * 4096, output), 2);
assert.equal(view.getBigUint64(output, true), BigInt(meta.kernelOffset));
assert.equal(view.getUint32(output + 8, true), 4096);
saved.copy(data, output, output, output + 16);
assert.deepEqual(data, saved, 'source-page planning must not materialize or alter the page');
data.set(kernel, base + 8 * 4096); // Single opaque authenticated fixture input.
for (const [address, target, source] of [
  [0x1000n, input, output], [0x1000n, 0, output], [0x1000n, base + 8192, base + 8192],
  [0xa0000n, base + 8192, output], [BigInt(meta.ramBytes), base + 8192, output],
]) {
  saved = Buffer.from(data);
  assert.equal(vm.vm_boot_project(address, target, source), -1);
  assert.deepEqual(data, saved);
}
for (const state of [0, input, base + 1]) {
  saved = Buffer.from(data);
  assert.equal(vm.vm_boot_initial_state(state), -1);
  assert.deepEqual(data, saved);
}
// Directory bytes are oracle setup, not a guest page walk or JS CPU state.
for (let i = 0; i < 7; ++i) {
  const at = directory + i * 32;
  view.setBigUint64(at, i < 6 ? BigInt((i + 1) * 4096) : BigInt(meta.kernelAddress), true);
  view.setUint32(at + 8, (i + 2) * 4096, true);
  view.setUint32(at + 12, 3, true); view.setUint32(at + 16, 1, true);
  view.setUint32(at + 20, 0, true); view.setUint32(at + 24, 0, true); view.setUint32(at + 28, 0, true);
}
view.setBigUint64(port, 9n, true);
assert.equal(vm.vm_open(base, data.length - base, 4096, directory, 7, 9n), 0);
assert.equal(vm.vm_bind_state(base), 0);
assert.equal(vm.vm_bind_segments(segments),0);
assert.equal(vm.vm_access(port, BigInt(meta.entry), 2, 9, 0n), 0n);
assert.equal(view.getUint16(port + 8, true), kernel.readUInt16LE(0x200));
assert.deepEqual(data.subarray(base, base + expectedState.length), expectedState);
// Pre-admit the data-read page walk before binding source/table rows. A/D
// updates otherwise correctly revoke the quantum and need cold re-admission.
assert.equal(vm.vm_access(port,0x1260n,4,1,0n),0n);
await checkStartup();
assert.equal(vm.vm_boot_initial_state(base), -1, 'live memory admission closes cold-loader writes');
assert.equal(vm.vm_boot_prepare(input, 0x200, BigInt(meta.imageBytes),
  BigInt(meta.initramfsBytes), BigInt(meta.ramBytes), input + 4096, command.length), -1);
saved = Buffer.from(data);
assert.equal(vm.vm_access(port, BigInt(meta.entry), 2, 9, 0n), 6n);
assert.equal(vm.vm_boot_initial_state(base), -1);
assert.deepEqual(data, saved, 'failed reopen revokes boot, memory and state admission');
console.log('Shipped bzImage -> C-Wasm initial pages/state -> C-MMU entry fetch: green; Linux boot NOT tested');
