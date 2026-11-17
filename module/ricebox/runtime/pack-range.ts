// A pack's bytes, read a range at a time (module/ricebox/make/layers.ts makes the packs): a file's bytes are fetched only when
// they are first wanted, and used only once they are checked against the pack's table (distribution/pack.ts). In a Worker the
// kernel reads inside a system call, where nothing can wait, so `syncRange` fetches synchronously (a synchronous
// Range request); `fetchStored` is the same read where one can wait. How a host fetches is not known here: whoever
// reads is given the host's way (sods' host.ts `rangeNow`, `range`) and hands it in. What puts a pack's tree in a
// kernel's is mount.ts.

export interface Ranged { status: number; bytes: Uint8Array }
export type ReadRange = (url: string, at: number, length: number) => Promise<Ranged>;
export type ReadRangeNow = (url: string, at: number, length: number) => Ranged;

import {LINE, checkFile, checkTable, type Sha256} from '../distribution/pack.ts';

/** The current pack response owned by one root reader, releasable independently of guest files. */
export interface PackRange {
  (pack: string, at: number, len: number): Uint8Array;
  held(): number;
  clear(): void;
  forget(pack: string): void;
}

/** Retain only the current whole response when its length is known from the verified root index. */
export function syncRange(base: string, rangeNow: ReadRangeNow, sizes?: ReadonlyMap<string, number>): PackRange {
  // The verified index is this reader's generation, not mutable caller state.
  const expected = sizes ? new Map(sizes) : undefined;
  let current: {name: string; bytes: Uint8Array} | null = null;
  const read = ((pack: string, at: number, len: number): Uint8Array => {
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(len) || at < 0 || len < 0 || !Number.isSafeInteger(at + len)) throw new RangeError('root: invalid pack range');
    const size = expected?.get(pack);
    if (expected && (size === undefined || !Number.isSafeInteger(size) || size < 0 || at + len > size)) throw new RangeError('root: range outside indexed pack');
    if (!len) return new Uint8Array(0);
    if (current?.name === pack) return current.bytes.subarray(at, at + len);
    // A different pack ends the previous response's lifetime, including
    // when the next read fails or uses HTTP 206. No eviction policy is needed.
    current = null;
    const url = new URL(`packs/${pack}`, base).href;
    let response: Ranged;
    try { response = rangeNow(url, at, len); }
    finally { current = null; } // A reentrant host must not retain its inner response.
    const {status, bytes} = response;
    if (status !== 206 && status !== 200) throw new Error(`root: ${url} answered ${status}`);
    if ((status === 206 && bytes.length !== len) || (status === 200 && (bytes.length < at + len || (size !== undefined && bytes.length !== size)))) throw new Error('root: wrong pack response length');
    if (status === 206) return bytes;
    if (size !== undefined) {
      // This bounds retained bytes by the indexed pack, not peak transport memory.
      const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : Uint8Array.from(bytes);
      current = {name: pack, bytes: own};
      return own.subarray(at, at + len);
    }
    return bytes.subarray(at, at + len);
  }) as PackRange;
  read.held = () => current?.bytes.byteLength ?? 0;
  read.clear = () => { current = null; };
  read.forget = (pack: string) => { if (current?.name === pack) current = null; };
  return read;
}

/** Where a file is in the root's packs, as the index says: its pack, its place there, and its line of that pack's table of `lines`. */
export interface Stored { url: string | URL; pack: string; at: number; len: number; lines: number; line: number }

/** Bytes [at, at+len) of a pack, by a Range request (of the whole pack, from a server that ignores Range). */
async function range(url: string | URL, pack: string, at: number, len: number, ranged: ReadRange): Promise<Uint8Array> {
  const {status, bytes} = await ranged(new URL(`packs/${pack}`, url).href, at, len);
  if (status !== 206 && status !== 200) throw new Error(`root: packs/${pack} answered ${status}`);
  return status === 200 ? bytes.subarray(at, at + len) : bytes;
}

/** A file's bytes as its pack holds them, fetched, once they are what the pack's table says (table.ts). */
export async function fetchStored({url, pack, at, len, lines, line}: Stored, sha256: Sha256, ranged: ReadRange): Promise<Uint8Array> {
  const [table, bytes] = await Promise.all([range(url, pack, 0, lines * LINE, ranged), range(url, pack, at, len, ranged)]);
  checkTable(table, pack, sha256);
  checkFile(bytes, table, line, pack, sha256);
  return bytes;
}

