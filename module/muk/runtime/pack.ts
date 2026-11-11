// A pack's bytes, read a range at a time (scripts/webroot.ts makes the packs): a file's bytes are fetched only when
// they are first wanted, and used only once they are checked against the pack's table (table.ts). In a Worker the
// kernel reads inside a system call, where nothing can wait, so `syncRange` fetches synchronously (a synchronous
// Range request); `fetchStored` is the same read where one can wait. What puts a pack's tree in a kernel's is the
// kernel's (../../ricebox/runtime/mount.ts).

import {LINE, checkFile, checkTable, type Sha256} from './table.ts';

/** In a Worker: the bytes [at, at+len) of a pack in `packs/` under `base`, fetched synchronously. */
export function syncRange(base: string): (pack: string, at: number, len: number) => Uint8Array {
  return (pack, at, len) => {
    if (!len) return new Uint8Array(0);
    const url = new URL(`packs/${pack}`, base).href;
    const x = new XMLHttpRequest();
    x.open('GET', url, false);
    x.responseType = 'arraybuffer';
    x.setRequestHeader('Range', `bytes=${at}-${at + len - 1}`);
    x.send();
    if (x.status !== 206 && x.status !== 200) throw new Error(`root: ${url} answered ${x.status}`);
    const bytes = new Uint8Array(x.response);
    // A server that ignores Range sends the whole pack.
    return x.status === 200 ? bytes.subarray(at, at + len) : bytes;
  };
}

/** Where a file is in the root's packs, as the index says: its pack, its place there, and its line of that pack's table of `lines`. */
export interface Stored { url: string | URL; pack: string; at: number; len: number; lines: number; line: number }

/** Bytes [at, at+len) of a pack, by a Range request (of the whole pack, from a server that ignores Range). */
async function range(url: string | URL, pack: string, at: number, len: number): Promise<Uint8Array> {
  const r = await fetch(new URL(`packs/${pack}`, url).href, {headers: {Range: `bytes=${at}-${at + len - 1}`}});
  if (r.status !== 206 && r.status !== 200) throw new Error(`root: packs/${pack} answered ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  return r.status === 200 ? bytes.subarray(at, at + len) : bytes;
}

/** A file's bytes as its pack holds them, fetched, once they are what the pack's table says (table.ts). */
export async function fetchStored({url, pack, at, len, lines, line}: Stored, sha256: Sha256): Promise<Uint8Array> {
  const [table, bytes] = await Promise.all([range(url, pack, 0, lines * LINE), range(url, pack, at, len)]);
  checkTable(table, pack, sha256);
  checkFile(bytes, table, line, pack, sha256);
  return bytes;
}
