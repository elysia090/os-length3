// Actual shipped header/page -> C-Wasm boot projection and MMU fetch.
// No instruction is executed; this cannot certify a Linux boot.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const [providerFile, prefix] = process.argv.slice(2);
if (!providerFile || !prefix) throw new Error('usage: check-wasm-boot.mjs VM.WASM NATIVE-RECORD-PREFIX');
const module = await WebAssembly.compile(await readFile(providerFile));
assert.deepEqual(WebAssembly.Module.imports(module), [
  { module: 'machine', name: 'memory', kind: 'memory' },
]);
const meta = JSON.parse(await readFile(`${prefix}.json`, 'utf8'));
const header = await readFile(`${prefix}.header`), command = await readFile(`${prefix}.command`);
const expectedState = await readFile(`${prefix}.state`), expectedPages = await readFile(`${prefix}.metadata`);
const kernel = await readFile(`${prefix}.kernel-page`);
assert.equal(header.length, 4096); assert.equal(kernel.length, 4096);
assert.equal(expectedPages.length, 6 * 4096);
const memory = new WebAssembly.Memory({ initial: 8, maximum: 16 });
const vm = (await WebAssembly.instantiate(module, { machine: { memory } })).exports;
const input = vm.vm_arena_min(), base = input + 4 * 4096;
const output = input + 8192, directory = input + 12288, port = base + 2048;
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
assert.equal(vm.vm_access(port, BigInt(meta.entry), 2, 9, 0n), 0n);
assert.equal(view.getUint16(port + 8, true), kernel.readUInt16LE(0x200));
assert.deepEqual(data.subarray(base, base + expectedState.length), expectedState);
assert.equal(vm.vm_boot_initial_state(base), -1, 'live memory admission closes cold-loader writes');
assert.equal(vm.vm_boot_prepare(input, 0x200, BigInt(meta.imageBytes),
  BigInt(meta.initramfsBytes), BigInt(meta.ramBytes), input + 4096, command.length), -1);
saved = Buffer.from(data);
assert.equal(vm.vm_access(port, BigInt(meta.entry), 2, 9, 0n), 6n);
assert.equal(vm.vm_boot_initial_state(base), -1);
assert.deepEqual(data, saved, 'failed reopen revokes boot, memory and state admission');
console.log('Shipped bzImage -> C-Wasm initial pages/state -> C-MMU entry fetch: green; Linux execution/boot NOT tested');
