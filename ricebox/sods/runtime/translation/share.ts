// A translation as the kernel runs it, made from the translator's wasm
// without the translator: its memory import marked shared when threads run
// apart (a shared memory needs a module that says so), and its data
// segments taken out and kept beside it. Instantiating such a module then
// writes nothing to memory, so a new thread of a running process (or a
// vfork child on its parent's memory) can be instantiated over the memory
// in use; exec writes the segments into the fresh memory itself.

/** A translation's data segment: bytes for guest memory at an offset. */
export interface Segment { offset: number; bytes: Uint8Array }

const leb = (b: Uint8Array, at: number): [number, number] => {
  let v = 0, shift = 0, byte;
  do { byte = b[at++]; v += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
  return [v, at];
};
const sleb32 = (b: Uint8Array, at: number): [number, number] => {
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
export function prepare(wasm: Uint8Array | ArrayBuffer, {shared = false}: {shared?: boolean} = {}): {wasm: Uint8Array<ArrayBuffer>; segments: Segment[] | null} {
  const {parts, segments, importIndex} = split(wasm, true);
  if (shared && importIndex >= 0) parts[importIndex] = sharedImport(parts[importIndex]!);
  return {wasm: join(parts), segments};
}

function join(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

/** Build-time extraction borrows the input instead of joining a second
 * giant module. Only the small import prefix has two memory-mode variants. */
export function deploymentParts(wasm: Uint8Array, maxHead: number): {
  head: Uint8Array<ArrayBuffer>; sharedHead: Uint8Array<ArrayBuffer> | undefined; code: Uint8Array[]; segments: Segment[];
} {
  const {parts, segments, importIndex, hasData} = split(wasm, false);
  if (hasData && !segments) throw new Error('cannot deploy opaque Wasm initialization as framed AOT');
  const first = parts.slice(0, Math.max(1, importIndex + 1));
  if (first.reduce((n, b) => n + b.length, 0) > maxHead) throw new Error('framed AOT import prefix is too large');
  const head = join(first);
  let sharedHead: Uint8Array<ArrayBuffer> | undefined;
  if (importIndex >= 0) {
    first[importIndex] = sharedImport(first[importIndex]!);
    const candidate = join(first);
    if (candidate.some((b, i) => b !== head[i])) sharedHead = candidate;
  }
  return {head, sharedHead, code: parts.slice(first.length), segments: segments ?? []};
}

function split(wasm: Uint8Array | ArrayBuffer, copySegments: boolean) {
  const b = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
  const parts = [b.subarray(0, 8)];
  let segments: Segment[] | null = null, at = 8, importIndex = -1;
  const sections: {id: number; start: number; body: number; end: number}[] = [];
  while (at < b.length) {
    const id = b[at];
    const [size, body] = leb(b, at + 1), end = body + size;
    if (!Number.isSafeInteger(end) || end > b.length) throw new Error('invalid Wasm section bounds');
    sections.push({id, start: at, body, end});
    at = end;
  }
  const data = sections.find((s) => s.id === 11);
  if (data) {
    const found: Segment[] = [];
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
      if (!Number.isSafeInteger(length) || length > data.end - p) { ok = false; break; }
      const bytes = b.subarray(p, p + length);
      found.push({offset: offset >>> 0, bytes: copySegments ? Uint8Array.from(bytes) : bytes});
      p += length;
    }
    if (ok && p === data.end) segments = found;
  }
  for (const s of sections) {
    if (segments && (s.id === 11 || s.id === 12)) continue;
    if (s.id === 2) importIndex = parts.length;
    parts.push(b.subarray(s.start, s.end));
  }
  return {parts, importIndex, segments, hasData: !!data};
}

function sharedImport(part: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = Uint8Array.from(part);
  const [, body] = leb(part, 1);
  shareMemoryImport(out, body);
  return out;
}

/** In an import section (its bytes, the body from `at`), mark each memory shared; its maximum is already there. */
function shareMemoryImport(s: Uint8Array, at: number): void {
  let count;
  [count, at] = leb(s, at);
  const name = (p: number): number => { const [n, q] = leb(s, p); return q + n; };
  const limits = (p: number, mark: boolean): number => {
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
export function lay(bytes: Uint8Array, segments: Segment[]): void {
  for (const s of segments) bytes.set(s.bytes, s.offset);
}
