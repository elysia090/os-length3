// Execute the same cold C decoder/planner/emitter in Wasm, not JavaScript.
// Compare exact emitted bytes with native C receipts; this is not Linux boot.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const [file, bundleDirectory, busyboxFile, ...fixtureDirectories] = process.argv.slice(2);
if (!file || !bundleDirectory || !busyboxFile)
  throw new Error('usage: check-cold-compiler.mjs COMPILER.WASM BUNDLE-PREFIX-DIRECTORY BUSYBOX.elf [FIXTURE-DIRECTORY ...]');
const compiled = await WebAssembly.compile(await readFile(file));
assert.deepEqual(WebAssembly.Module.imports(compiled), [{module:'machine',name:'memory',kind:'memory'}]);
const memory = new WebAssembly.Memory({initial:128,maximum:256});
const c = (await WebAssembly.instantiate(compiled,{machine:{memory}})).exports;
const input = c.compiler_arena_min(), output = input + 1024 * 1024, report = output + 65536;
assert.equal(c.compiler_report_bytes(),80);
assert(report + 80 <= memory.buffer.byteLength);
let count = 0;
function transport() { return Buffer.from(memory.buffer); }
function data() { return new DataView(memory.buffer); }
async function compare(prefix, entry, instructions) {
  const expected = await readFile(`${prefix}.wasm`);
  assert.equal(c.compiler_emit(BigInt(entry),instructions,output,65536,report),0,prefix);
  const bytes = Number(data().getBigUint64(report + 40,true));
  assert.equal(bytes,expected.length);
  assert.deepEqual(transport().subarray(output,output + bytes),expected,`${prefix}: native C / cold C-Wasm emission`);
  assert.equal(data().getBigUint64(report,true),BigInt(entry));
  ++count;
}

const boot = JSON.parse(await readFile(path.join(bundleDirectory,'boot.json'),'utf8'));
const page = await readFile(path.join(bundleDirectory,'boot.kernel-page'));
transport().set(page,input);
assert.equal(c.compiler_open_pages(input,1,BigInt(boot.kernelAddress),9n),0);
const kernelSummary = JSON.parse(await readFile(path.join(bundleDirectory,'kernel.summary.json'),'utf8'));
for (const cut of kernelSummary.cuts) {
  const prefix = path.join(bundleDirectory,cut.rank ? `kernel.${cut.rank}` : 'kernel');
  await compare(prefix,cut.entry,1024);
}
transport().fill(0xa5,output,output + 65536); transport().fill(0xa5,report,report + 80);
const saved = Buffer.from(transport().subarray(input,report + 80));
if (kernelSummary.stop.kind === 'control') {
  const final = kernelSummary.cuts.at(-1);
  await compare(path.join(bundleDirectory,final.rank ? `kernel.${final.rank}` : 'kernel'),final.entry,1024);
} else {
  assert.equal(c.compiler_emit(BigInt(kernelSummary.stop.entry),1024,output,65536,report),-102);
  assert.deepEqual(transport().subarray(input,report + 80),saved,'unsupported bundle coordinate must not publish or mutate source/output');
}
assert.deepEqual(transport().subarray(input,input + page.length),page);

// Optional fixed shipped-startup witnesses, not speculative branch closure.
for (const [prefix,sourceName,address] of [['after-return','boot.kernel-page',BigInt(boot.kernelAddress)],
    ['control-read','boot.kernel-page',BigInt(boot.kernelAddress)],
    ['idt','call.extra-page',0x12e3000n]]) {
  let summary;
  try { summary = JSON.parse(await readFile(path.join(bundleDirectory,`${prefix}.summary.json`))); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  const source = await readFile(path.join(bundleDirectory,sourceName));
  assert.equal(source.length,4096); transport().set(source,input);
  assert.equal(c.compiler_open_pages(input,1,address,9n),0);
  for (const cut of summary.cuts)
    await compare(path.join(bundleDirectory,cut.rank ? `${prefix}.${cut.rank}` : prefix),cut.entry,1024);
}

const busybox = await readFile(busyboxFile);
assert(busybox.length <= output - input);
transport().set(busybox,input);
assert.equal(c.compiler_open_elf(input,busybox.length),0);
const busyboxSummary = JSON.parse(await readFile(path.join(bundleDirectory,'busybox.summary.json'),'utf8'));
for (const cut of busyboxSummary.cuts) {
  const prefix = path.join(bundleDirectory,cut.rank ? `busybox.${cut.rank}` : 'busybox');
  await compare(prefix,cut.entry,1024);
}
assert.deepEqual(transport().subarray(input,input + busybox.length),busybox,'borrowed shipped ELF unchanged');

for (const directory of fixtureDirectories) {
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.json')).sort()) {
    const prefix = path.join(directory,name.slice(0,-5));
    const meta = JSON.parse(await readFile(`${prefix}.json`,'utf8'));
    if (meta.entry === undefined) continue;
    let source, elf = false;
    try { source = await readFile(`${prefix}.source-page`); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      source = await readFile(`${prefix}.optimized.elf`); elf = true;
    }
    assert(source.length <= output - input);
    transport().set(source,input);
    if (elf) assert.equal(c.compiler_open_elf(input,source.length),0);
    else {
      assert.equal(source.length,4096);
      assert.equal(c.compiler_open_pages(input,1,BigInt(meta.entry) & ~4095n,9n),0);
    }
    await compare(prefix,meta.entry,meta.instructions ?? 1);
  }
}

// Invalid wrapper offsets, aliases, capacity/options and rejected reopen are
// observable rejection, never Wasm traps or a stale accepted input.
transport().set(page,input);
assert.equal(c.compiler_open_pages(input,1,BigInt(boot.kernelAddress),9n),0);
for (const args of [
  [output,1,report], [input,65536,report], [output,65536,report + 1],
  [output,65536,input], [output,65536,output], [0,65536,report],
  [0xfffffff0,65536,report], [output,65536,0xfffffff8],
]) {
  const before = Buffer.from(transport().subarray(input,report + 80));
  assert.notEqual(c.compiler_emit(BigInt(boot.entry),1024,...args),0);
  assert(transport().subarray(input,report + 80).equals(before),'rejected reservations preserve caller arena (not private C stack scratch)');
}
for (const instructions of [0,1025]) {
  const before = Buffer.from(transport().subarray(input,report + 80));
  assert.equal(c.compiler_emit(BigInt(boot.entry),instructions,output,65536,report),-100);
  assert(transport().subarray(input,report + 80).equals(before));
}
assert.equal(c.compiler_open_elf(0,4096),-100);
assert.equal(c.compiler_emit(BigInt(boot.entry),1024,output,65536,report),-100);
transport().fill(0,input,input + 64);
assert.equal(c.compiler_open_elf(input,64),-101);
assert.equal(c.compiler_emit(BigInt(boot.entry),1024,output,65536,report),-100);
for (const args of [[input,0,0n,9n],[input,3,0n,9n],[input,1,1n,9n],
                    [input,1,0n,0n],[input,1,0xfffffffffffff000n,9n]])
  assert.equal(c.compiler_open_pages(...args),-100);
memory.grow(1);
transport().set(page,input);
assert.equal(c.compiler_open_pages(input,1,BigInt(boot.kernelAddress),9n),0);
await compare(path.join(bundleDirectory,'kernel'),boot.entry,1024);
c.compiler_close();
assert.equal(c.compiler_emit(BigInt(boot.entry),1024,output,65536,report),-100);
console.log(`Native bundle / fixtures -> cold C-Wasm compiler: green (${count} byte-identical emissions, including repeats; no WASI/JS decoder; Linux boot NOT tested)`);
