// A translation as the kernel runs it, made from the translator's wasm
// without the translator: its memory import marked shared when threads run
// apart (a shared memory needs a module that says so), and its data
// segments taken out and kept beside it. Instantiating such a module then
// writes nothing to memory, so a new thread of a running process (or a
// vfork child on its parent's memory) can be instantiated over the memory
// in use; exec writes the segments into the fresh memory itself.

const leb = (b, at) => {
  let v = 0, shift = 0, byte;
  do { byte = b[at++]; v += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
  return [v, at];
};
const sleb32 = (b, at) => {
  let v = 0, shift = 0, byte;
  do { byte = b[at++]; v |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
  if (shift < 32 && byte & 0x40) v |= -1 << shift;
  return [v, at];
};

/**
 * {wasm, segments}: `wasm` as given with its memory import shared (when
 * `shared`) and without its data (when every segment is an active one at a
 * constant offset, as the translator makes them; `segments` is then
 * [{offset, bytes}], else null and the data stays in).
 */
export function prepare(wasm, {shared = false} = {}) {
  const b = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
  const parts = [b.subarray(0, 8)];
  let segments = null, at = 8;
  const sections = [];
  while (at < b.length) {
    const id = b[at];
    const [size, body] = leb(b, at + 1);
    sections.push({id, start: at, body, end: body + size});
    at = body + size;
  }
  const data = sections.find((s) => s.id === 11);
  if (data) {
    const found = [];
    let p = data.body, ok = true;
    let count;
    [count, p] = leb(b, p);
    for (let k = 0; k < count && ok; k++) {
      let flag;
      [flag, p] = leb(b, p);
      if (flag !== 0 || b[p] !== 0x41) { ok = false; break; }
      let offset;
      [offset, p] = sleb32(b, p + 1);
      if (b[p] !== 0x0b) { ok = false; break; }
      let length;
      [length, p] = leb(b, p + 1);
      found.push({offset: offset >>> 0, bytes: b.slice(p, p + length)});
      p += length;
    }
    if (ok) segments = found;
  }
  for (const s of sections) {
    if (segments && (s.id === 11 || s.id === 12)) continue; // the data, and its count
    if (s.id === 2 && shared) {
      const section = b.slice(s.start, s.end);
      shareMemoryImport(section, s.body - s.start);
      parts.push(section);
      continue;
    }
    parts.push(b.subarray(s.start, s.end));
  }
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return {wasm: out, segments};
}

/** In an import section (its bytes, the body from `at`), mark each memory shared; its maximum is already there. */
function shareMemoryImport(s, at) {
  let count;
  [count, at] = leb(s, at);
  const name = (p) => { const [n, q] = leb(s, p); return q + n; };
  const limits = (p, mark) => {
    const flag = s[p];
    if (mark) {
      if (!(flag & 1)) throw new Error('a shared memory needs a maximum');
      s[p] = flag | 2;
    }
    let q = p + 1;
    [, q] = leb(s, q);
    if (flag & 1) [, q] = leb(s, q);
    return q;
  };
  for (let k = 0; k < count; k++) {
    at = name(name(at));
    const kind = s[at++];
    if (kind === 0) [, at] = leb(s, at);
    else if (kind === 1) at = limits(at + 1, false);
    else if (kind === 2) at = limits(at, true);
    else if (kind === 3) at += 2;
    else if (kind === 4) [, at] = leb(s, at + 1);
    else throw new Error(`import kind ${kind}`);
  }
}

/** Write `segments` into `memory`'s bytes. */
export function lay(bytes, segments) {
  for (const s of segments) bytes.set(s.bytes, s.offset);
}
