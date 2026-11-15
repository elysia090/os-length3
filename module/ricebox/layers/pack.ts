// A pack's bytes, read a range at a time (module/ricebox/make/layers.ts makes the packs): a file's bytes are fetched only when
// they are first wanted, and used only once they are checked against the pack's table (table.ts). In a Worker the
// kernel reads inside a system call, where nothing can wait, so `syncRange` fetches synchronously (a synchronous
// Range request); `fetchStored` is the same read where one can wait. How a host fetches is not known here: whoever
// reads is given the host's way (sods' host.ts `rangeNow`, `range`) and hands it in. What puts a pack's tree in a
// kernel's is mount.ts.

export interface Ranged { status: number; bytes: Uint8Array }
export type ReadRange = (url: string, at: number, length: number) => Promise<Ranged>;
export type ReadRangeNow = (url: string, at: number, length: number) => Ranged;

import {LINE, checkFile, checkTable, type Sha256} from './table.ts';

/** In a Worker: the bytes [at, at+len) of a pack in `packs/` under `base`, fetched synchronously. */
export function syncRange(base: string, rangeNow: ReadRangeNow): (pack: string, at: number, len: number) => Uint8Array {
  return (pack, at, len) => {
    if (!len) return new Uint8Array(0);
    const url = new URL(`packs/${pack}`, base).href;
    const {status, bytes} = rangeNow(url, at, len);
    if (status !== 206 && status !== 200) throw new Error(`root: ${url} answered ${status}`);
    // A server that ignores Range sends the whole pack.
    return status === 200 ? bytes.subarray(at, at + len) : bytes;
  };
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
