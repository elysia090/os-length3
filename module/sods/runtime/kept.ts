// A translation as it is kept between runs: written by the page (src/app/prompt/userland.ts) and by
// scripts/webroot-runnable.ts, read back by a kernel through its keeper (muk/runtime/keeper.ts), which seals each copy
// with the SHA-256 of its body and checks it as it reads. These are the bodies.
//
//   main: 'L3T1', its data segments (count, or 0xffffffff when they are in the module, then offset, length and
//         bytes of each), the module's length and bytes
//   more: 'L3M1', how many modules, then each one's first table slot, length and bytes (Image.adopt)

import type {Segment} from './share.ts';

export const MAIN = 0x4c335431, MORE = 0x4c334d31;

/** A module of code reached later, as kept: its first table slot and bytes. */
export interface More { base: number; bytes: Uint8Array<ArrayBuffer> }
/** A kept translation, read: its module, its data segments (null: in the module), its size and its later code. */
export interface Taken { module: WebAssembly.Module; segments: Segment[] | null; size: number; more: {module: WebAssembly.Module; bytes: Uint8Array; base: number}[] }

/** Big-endian u32s, as each head and each size in the kept forms. */
function u32s(...xs: number[]): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(4 * xs.length), v = new DataView(b.buffer);
  xs.forEach((x, i) => v.setUint32(4 * i, x));
  return b;
}

/** 'L3T1' for a module and its data segments (null: they are in the module), as parts to be joined. */
export function packMain(wasm: Uint8Array, segments: Segment[] | null): Uint8Array[] {
  return [u32s(MAIN, segments ? segments.length : 0xffffffff), ...(segments ?? []).flatMap((s) => [u32s(s.offset, s.bytes.length), s.bytes]),
    u32s(wasm.length), wasm];
}

/** 'L3M1' for modules of code reached later, as parts to be joined. */
export function packMore(list: {bytes: Uint8Array; base: number}[]): Uint8Array[] {
  return [u32s(MORE, list.length), ...list.flatMap((m) => [u32s(m.base, m.bytes.length), m.bytes])];
}

/** The modules of an 'L3M1' body: [{base, bytes}], or [] if it is not one. */
export function unpackMore(body: Uint8Array): More[] {
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (body.length < 8 || v.getUint32(0) !== MORE) return [];
  const out: More[] = [];
  for (let at = 8, k = v.getUint32(4); k > 0 && at + 8 <= body.length; k--) {
    const len = v.getUint32(at + 4);
    out.push({base: v.getUint32(at), bytes: body.slice(at + 8, at + 8 + len)});
    at += 8 + len;
  }
  return out;
}

/** A kept translation's bodies (`main`, and `more` or null) compiled for a kernel; null when `main` is not 'L3T1'. */
export function taken(main: Uint8Array<ArrayBuffer>, more: Uint8Array | null): Taken | null {
  const v = new DataView(main.buffer, main.byteOffset, main.byteLength);
  if (main.length < 8 || v.getUint32(0) !== MAIN) return null;
  let at = 8;
  const count = v.getUint32(4), segments: Segment[] | null = count === 0xffffffff ? null : [];
  for (let k = segments ? count : 0; segments && k > 0; k--) {
    const offset = v.getUint32(at), len = v.getUint32(at + 4);
    segments.push({offset, bytes: main.slice(at + 8, at + 8 + len)});
    at += 8 + len;
  }
  const wasm = main.slice(at + 4, at + 4 + v.getUint32(at));
  // Compiled here and now (the kernel runs in a Worker, and waits for it): a compile handed to the engine's own
  // threads waits behind what they are busy with, a running program's code being optimized, often for far longer.
  const module = new WebAssembly.Module(wasm);
  // Only the modules that follow on from this one (each from the table slot the one before it ended at): what was
  // kept of code reached later from an earlier translation of the program (before it was consolidated) is not.
  let slots = (WebAssembly.Module.customSections(module, 'xlat.starts')[0]?.byteLength ?? 0) / 8;
  const extras: More[] = [];
  for (const e of more ? unpackMore(more) : []) {
    if (e.base !== slots) break;
    extras.push(e);
    slots += startsIn(e.bytes);
  }
  const modules = extras.map((e) => new WebAssembly.Module(e.bytes));
  return {module, segments, size: wasm.length, more: extras.map((e, k) => ({module: modules[k], bytes: e.bytes, base: e.base}))};
}

/** How many functions a module of code reached later adds (its xlat.starts section, read from its bytes). */
function startsIn(bytes: Uint8Array): number {
  const leb = (at: number): [number, number] => { let v = 0, shift = 0, b; do { b = bytes[at++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); return [v, at]; };
  const name = new TextEncoder().encode('xlat.starts');
  for (let at = 8; at < bytes.length;) {
    const id = bytes[at];
    const [size, body] = leb(at + 1);
    if (id === 0) {
      const [n, p] = leb(body);
      if (n === name.length && name.every((c, k) => bytes[p + k] === c)) return (body + size - (p + n)) / 8;
    }
    at = body + size;
  }
  return 0;
}
