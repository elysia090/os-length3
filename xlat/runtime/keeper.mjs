// Translations kept from earlier runs, read where the kernel runs (worker.mjs). The page keeps them (os/src/userland.ts,
// within its share of the browser's room) in Cache Storage, each program's under the origin of its file in the root
// (pack.mjs: its pack, named by its digest, and its place in it), and says at the start which there are:
// kept = {cache, at: {[origin]: {main, more}}}, the URL of a program's translation and that of the code it reached
// later (or null). A program run for the first time in this kernel is then read from there, not translated again, and
// the exec that wants it waits only for that read. Each copy ends with the SHA-256 of what comes before it, checked
// as it is read: one that is not what was kept is not used, and its program is translated as any other.
//
//   main: 'L3T1', its data segments (count, or 0xffffffff when they are in the module, then offset, length and
//         bytes of each), the module's length and bytes
//   more: 'L3M1', how many modules, then each one's first table slot, length and bytes (Image.adopt)

export const MAIN = 0x4c335431, MORE = 0x4c334d31;

/**
 * {has(origin), take(origin)} for a Kernel: take starts reading what is kept for `origin` and says undefined until it
 * is read, then gives it once ({module, segments, size, more}), or null for good if it could not be had. `ready` is
 * called whenever a read ends (the kernel looks again); `read(urls)` hears what was read, for the page to count as used.
 */
export function keeper(kept, ready, read = () => {}) {
  const state = new Map(); // origin -> 'reading' | what was read | null
  return {
    has: (origin) => Object.hasOwn(kept.at, origin) && state.get(origin) !== null,
    /** How many are being read now. */
    reading: () => [...state.values()].filter((s) => s === 'reading').length,
    take(origin) {
      const s = state.get(origin);
      if (s === 'reading') return undefined;
      if (s === null) return null;
      // Given once: freed later (Kernel.free), it is read again rather than held here.
      if (s !== undefined) { state.delete(origin); return s; }
      state.set(origin, 'reading');
      const urls = kept.at[origin];
      load(kept.cache, urls).then((v) => { state.set(origin, v); if (v) read([urls.main, ...(urls.more ? [urls.more] : [])]); },
        () => state.set(origin, null)).finally(ready);
      return undefined;
    },
  };
}

/** What is kept at `url` without its digest, if it is what was kept. */
async function checked(cache, url) {
  const r = await cache.match(url);
  if (!r) return null;
  const all = new Uint8Array(await r.arrayBuffer());
  if (all.length < 40) return null;
  const body = all.subarray(0, all.length - 32);
  const sum = new Uint8Array(await crypto.subtle.digest('SHA-256', body));
  for (let i = 0; i < 32; i++) if (sum[i] !== all[all.length - 32 + i]) return null;
  return body;
}

/** A kept translation's parts, compiled; null when it is not there or not what was kept. */
async function load(name, {main, more}) {
  const cache = await caches.open(name);
  const [m, x] = await Promise.all([checked(cache, main), more ? checked(cache, more).catch(() => null) : null]);
  if (!m) return null;
  const v = new DataView(m.buffer, m.byteOffset, m.byteLength);
  if (v.getUint32(0) !== MAIN) return null;
  let at = 8;
  const count = v.getUint32(4), segments = count === 0xffffffff ? null : [];
  for (let k = segments ? count : 0; k > 0; k--) {
    const offset = v.getUint32(at), len = v.getUint32(at + 4);
    segments.push({offset, bytes: m.slice(at + 8, at + 8 + len)});
    at += 8 + len;
  }
  const wasm = m.slice(at + 4, at + 4 + v.getUint32(at));
  // Compiled here and now (the kernel runs in a Worker, and waits for it): a compile handed to the engine's own
  // threads waits behind what they are busy with, a running program's code being optimized, often for far longer.
  const module = new WebAssembly.Module(wasm);
  // Only the modules that follow on from this one (each from the table slot the one before it ended at): what was
  // kept of code reached later from an earlier translation of the program (before it was consolidated) is not.
  let slots = WebAssembly.Module.customSections(module, 'xlat.starts')[0]?.byteLength / 8 || 0;
  const extras = [];
  for (const e of x ? unpackMore(x) : []) {
    if (e.base !== slots) break;
    extras.push(e);
    slots += moreStarts(e.bytes);
  }
  const modules = extras.map((e) => new WebAssembly.Module(e.bytes));
  return {module, segments, size: wasm.length, more: extras.map((e, k) => ({module: modules[k], bytes: e.bytes, base: e.base}))};
}

/** How many functions a module of code reached later adds (its xlat.starts section, read from its bytes). */
function moreStarts(bytes) {
  const leb = (at) => { let v = 0, shift = 0, b; do { b = bytes[at++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80); return [v, at]; };
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

/** Kept modules of code reached later ('L3M1', without its digest): [{base, bytes}], or [] if it is not that. */
export function unpackMore(body) {
  const v = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (body.length < 8 || v.getUint32(0) !== MORE) return [];
  const out = [];
  for (let at = 8, k = v.getUint32(4); k > 0 && at + 8 <= body.length; k--) {
    const len = v.getUint32(at + 4);
    out.push({base: v.getUint32(at), bytes: body.slice(at + 8, at + 8 + len)});
    at += 8 + len;
  }
  return out;
}
