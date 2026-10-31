// Filling and copying within a process's memory as WebAssembly itself does it (memory.fill, memory.copy: the host's
// memset and memmove). Over a shared memory a TypedArray's fill stores byte by byte (V8 makes each store an atomic
// one), seven times slower: 5 ms rather than 0.75 for the 15 MiB a fork of sh zeroes. So what is large goes
// through a module of two functions over the memory, made once for each memory and kept with it.
//
//   zero(memory, from, to)          bytes [from, to) are 0
//   move(memory, to, from, length)  bytes [from, from + length) are copied to `to` (the two may overlap)
//
// What is small (a struct a call fills) stays a TypedArray's: a call into wasm costs more than a few bytes do.

/** (memory "m" "m" (imported; shared or not)) (func fill (i32 i32 i32)) (func copy (i32 i32 i32)), exported as such. */
const module = (shared) => new WebAssembly.Module(new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  0x01, 0x07, 0x01, 0x60, 0x03, 0x7f, 0x7f, 0x7f, 0x00, // type 0: (i32, i32, i32) -> ()
  // import "m" "m": a memory of at least 1 page; shared, with the largest maximum (any shared memory matches it), or
  // with no maximum (any other does)
  ...(shared ? [0x02, 0x0b, 0x01, 0x01, 0x6d, 0x01, 0x6d, 0x02, 0x03, 0x01, 0x80, 0x80, 0x04]
    : [0x02, 0x08, 0x01, 0x01, 0x6d, 0x01, 0x6d, 0x02, 0x00, 0x01]),
  0x03, 0x03, 0x02, 0x00, 0x00, // two functions of type 0
  0x07, 0x0f, 0x02, 0x04, 0x66, 0x69, 0x6c, 0x6c, 0x00, 0x00, 0x04, 0x63, 0x6f, 0x70, 0x79, 0x00, 0x01, // export fill, copy
  0x0a, 0x1a, 0x02,
  0x0b, 0x00, 0x20, 0x00, 0x20, 0x01, 0x20, 0x02, 0xfc, 0x0b, 0x00, 0x0b, // fill: memory.fill(dst, value, length)
  0x0c, 0x00, 0x20, 0x00, 0x20, 0x01, 0x20, 0x02, 0xfc, 0x0a, 0x00, 0x00, 0x0b, // copy: memory.copy(dst, src, length)
]));

/** Below this many bytes a TypedArray's own fill or copy is as fast. */
const LARGE = 4096;

const modules = {};
const helpers = new WeakMap();
const isShared = (memory) => typeof SharedArrayBuffer === 'function' && memory.buffer instanceof SharedArrayBuffer;

function helper(memory) {
  let h = helpers.get(memory);
  if (!h) {
    const shared = isShared(memory);
    h = new WebAssembly.Instance(modules[shared] ??= module(shared), {m: {m: memory}}).exports;
    helpers.set(memory, h);
  }
  return h;
}

/** Bytes [from, to) of `memory` are 0. */
export function zero(memory, from, to) {
  if (to <= from) return;
  if (to - from < LARGE) new Uint8Array(memory.buffer).fill(0, from, to);
  else helper(memory).fill(from, 0, to - from);
}

/** Bytes [from, from + length) of `memory` are copied to `to` (the two ranges may overlap). */
export function move(memory, to, from, length) {
  if (length <= 0) return;
  if (length < LARGE) new Uint8Array(memory.buffer).copyWithin(to, from, from + length);
  else helper(memory).copy(to, from, length);
}
