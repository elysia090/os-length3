// Oracle input/model checks only. These helpers never implement guest reads.
import assert from 'node:assert/strict';
export function seedNativeSelector(view, base, meta) {
  if (!meta.selector?.enabled) return;
  const selector = meta.selector;
  assert.equal(selector.native.length, 6);
  assert(selector.rank < 6);
  view.setBigUint64(base + selector.offset + selector.rank * 8,
    BigInt(selector.native[selector.rank]), true);
}
export function checkSelectorModel(cut, memory, meta) {
  if (!meta.selector?.enabled) return 0;
  assert.equal(meta.instructions, 1);
  const {offset, rank, width, destination} = meta.selector;
  assert([16, 32, 64].includes(width));
  let comparisons = 0;
  for (let row = 0; row < 512; ++row) {
    const contents = Buffer.from(memory.buffer); contents.fill(0x5a);
    const view = new DataView(memory.buffer);
    // Every null RPL/TI, boundary, and unrelated descriptor index is read
    // without validating a descriptor. Upper reserved storage is masked.
    const value = BigInt(row < 16 ? row : (row * 65521) & 65535);
    view.setBigUint64(offset + rank * 8, 0xdead000000000000n | value, true);
    view.setBigUint64(meta.ripOffset, BigInt(meta.entry), true);
    const flags = 0x202n | BigInt((row & 63) * 17 & 0xcd5) | (row & 1 ? 0x10000n : 0n);
    view.setBigUint64(meta.flagsOffset, flags, true);
    view.setBigUint64(meta.retiredOffset, 42n, true);
    const expected = Buffer.from(contents);
    const next = new DataView(expected.buffer, expected.byteOffset, expected.byteLength);
    const old = view.getBigUint64(destination * 8, true);
    next.setBigUint64(destination * 8, width === 16 ? (old & ~65535n) | value : value, true);
    next.setBigUint64(meta.ripOffset, BigInt(meta.entry) + BigInt(meta.sourceBytes), true);
    next.setBigUint64(meta.flagsOffset, flags & ~0x10000n, true);
    next.setBigUint64(meta.retiredOffset, 43n, true);
    assert.equal(cut(0), 1n);
    assert.deepEqual(contents, expected, `guest selector model row ${row}`);
    ++comparisons;
  }
  return comparisons;
}
