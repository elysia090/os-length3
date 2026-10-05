// Actual C compiler output against native x86 observations. Node is the Wasm
// engine oracle here, not a browser boot or a guest execution fallback.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {seedDisabledDebug} from './machine-observation.mjs';
import {seedNativeSelector, checkSelectorModel} from './selector-observation.mjs';
const directory = process.argv[2];
if (!directory) throw new Error('usage: node check-wasm-cuts.mjs RECORD-DIRECTORY');
const files = (await readdir(directory)).filter(name => name.endsWith('.json')).sort();
assert(files.length > 0, 'no actual native oracle records');
let comparisons = 0, legacyTwinModules = 0, zeroRepresentatives = 0, selectorModels = 0;
for (const file of files) {
  const prefix = path.join(directory, file.slice(0, -5));
  const meta = JSON.parse(await readFile(`${prefix}.json`, 'utf8'));
  if (meta.summary?.nativeLegacyPrefixTwin) ++legacyTwinModules;
  if (file === 'composed.json')
    assert(meta.moduleBytes <= 400, 'dead intermediate flags reintroduced into the composed cut');
  if (file === 'special-12.json')
    assert(meta.moduleBytes <= 360, 'ADD -> INC must retain carry only from the earlier writer');
  const bytes = await readFile(`${prefix}.wasm`);
  assert.equal(bytes.length, meta.moduleBytes);
  const module = await WebAssembly.compile(bytes);
  assert.deepEqual(WebAssembly.Module.imports(module), [
    { module: 'machine', name: 'memory', kind: 'memory' },
  ], 'compiled cut has no interpreter, source reader or host function imports');
  assert.deepEqual(WebAssembly.Module.exports(module), [{ name: 'cut', kind: 'function' }]);
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 4 });
  const instance = await WebAssembly.instantiate(module, { machine: { memory } });
  assert.equal(instance.exports.cut.length,3,'ABI-2 fixture required; regenerate, never adapt old modules');
  const cases = await readFile(`${prefix}.cases`);
  const records = new DataView(cases.buffer, cases.byteOffset, cases.byteLength);
  const masks = await readFile(`${prefix}.flags-masks`).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null; // Older immutable receipts use the recorded common mask.
  });
  if (masks) assert.equal(masks.length, 512 * 8);
  assert.equal(cases.length, 512 * 35 * 8);
  assert.equal(meta.stateBytes % 8, 0);
  for (let row = 0; row < 512; ++row) {
    if (row === 256) assert.equal(memory.grow(1), 1);
    const actual = Buffer.from(memory.buffer);
    actual.fill(0xa5);
    const offset = [0, 4096, actual.length - meta.stateBytes][row % 3];
    const view = new DataView(memory.buffer);
    const word = rank => records.getBigUint64((row * 35 + rank) * 8, true);
    for (let reg = 0; reg < 16; ++reg) view.setBigUint64(offset + reg * 8, word(reg), true);
    view.setBigUint64(offset + meta.ripOffset, BigInt(meta.entry), true);
    // RF restored by IRETQ is legal at entry and clears only after successful
    // retirement. Native rows have RF=0; replay their same defined result.
    view.setBigUint64(offset + meta.flagsOffset, word(16) | (row >= 384 ? 0x10000n : 0n), true);
    view.setBigUint64(offset + meta.retiredOffset, 0xfffffffffffffffen, true);
    seedNativeSelector(view, offset, meta);
    seedDisabledDebug(view, offset);
    const expected = Buffer.from(actual);
    const expectedView = new DataView(expected.buffer, expected.byteOffset, expected.byteLength);
    for (let reg = 0; reg < 16; ++reg)
      expectedView.setBigUint64(offset + reg * 8, word(17 + reg), true);
    // Compare every defined native output. A zero-source legacy scan's
    // destination is undefined; separately enforce the documented incoming
    // whole-parent representative instead of claiming it as a hardware value.
    if (meta.summary?.undefinedZeroDestination
        && !(word(meta.summary.source) & ((1n<<BigInt(meta.summary.width))-1n))) {
      expectedView.setBigUint64(offset+meta.summary.destination*8,word(meta.summary.destination),true);
      ++zeroRepresentatives;
    }
    expectedView.setBigUint64(offset + meta.ripOffset, word(34), true);
    expectedView.setBigUint64(offset + meta.retiredOffset,
      BigInt.asUintN(64, 0xfffffffffffffffen + BigInt(meta.instructions)), true);
    assert.equal(instance.exports.cut(offset,0,BigInt(meta.entry)), 1n, `${file}: result row ${row}`);
    const flags = view.getBigUint64(offset + meta.flagsOffset, true);
    assert.equal(flags & 0x10000n,0n,`${file}: successful RF clear row ${row}`);
    const mask = masks ? masks.readBigUInt64LE(row * 8) : BigInt(meta.flagsMask);
    assert.equal(flags & mask, word(33) & mask, `${file}: defined flags row ${row}`);
    expectedView.setBigUint64(offset + meta.flagsOffset, flags, true);
    assert.deepEqual(actual, expected, `${file}: complete memory/cut row ${row}`);
    ++comparisons;
  }
  selectorModels += checkSelectorModel(instance.exports.cut, memory, meta);
  const view = new DataView(memory.buffer);
  const contents = Buffer.from(memory.buffer);
  contents.fill(0x5a);
  seedDisabledDebug(view, 0);
  view.setBigUint64(meta.ripOffset, BigInt(meta.entry), true);
  view.setBigUint64(meta.flagsOffset, 0x202n, true);
  for (const badOffset of [1, -1, contents.length - meta.stateBytes + 8, contents.length]) {
    const snapshot = Buffer.from(contents);
    assert.equal(instance.exports.cut(badOffset,0,BigInt(meta.entry)), 6n, `${file}: invalid reservation`);
    assert.deepEqual(contents, snapshot);
  }
  for (const flags of [0x302n, 0x10302n]) {
    view.setBigUint64(meta.flagsOffset, flags, true);
    const snapshot = Buffer.from(contents);
    assert.equal(instance.exports.cut(0,0,BigInt(meta.entry)), 6n, `${file}: debug cut rejection`);
    assert.deepEqual(contents, snapshot);
  }
  view.setBigUint64(meta.flagsOffset, 0x202n, true);
  view.setBigUint64(meta.ripOffset, BigInt(meta.entry) + 1n, true);
  const snapshot = Buffer.from(contents);
  assert.equal(instance.exports.cut(0,0,BigInt(meta.entry)), 6n, `${file}: wrong RIP`);
  assert.deepEqual(contents, snapshot);
}
console.log(`Generated Wasm/native x86: green (${files.length} modules, ${comparisons} comparisons; ${selectorModels} guest selector models; ${legacyTwinModules} legacy-prefix native twins, ${zeroRepresentatives} chosen undefined zero destinations; not Linux/browser boot)`);
