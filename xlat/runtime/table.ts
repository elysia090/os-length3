// What makes a file read from a pack alone (one Range of it) as checked as the whole pack would be. A pack begins with
// its table: the SHA-256 of each file it stores (its bytes as stored: zstd frames, or as it is), one 32-byte line
// each, in the order the files are in it; and the pack is named by the SHA-256 of its table. A file's bytes are
// checked against its line, the table against the pack's name, and the name is the index's, which is checked against
// the digest a release pins: so nothing read from a pack is used before it is known to be the root's. The writer
// (os/scripts/l3.ts), every reader (pack.ts, ahead.ts, os/scripts/l3-tree.ts, os/scripts/prompt-files.ts) and
// their tests take this one account of it. `sha256(bytes)` gives the 32 bytes of a digest: the translator's in a
// browser (where a system call must have the bytes at once), node's elsewhere.

/** Bytes of a line of a table. */
export const LINE = 32;

/** What a pack's reader is told of the index: its packs, and each file's place in one. */
export interface Packed { packs: {name: string; owner?: string; bytes: number}[]; files: {pack: number; at: number; len: number}[] }
/** The 32 bytes of a SHA-256 of some bytes. */
export type Sha256 = (bytes: Uint8Array) => Uint8Array;

const hex = (d: Uint8Array): string => Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * A pack of `stored` (each file's bytes as it is to be stored, none empty), in that order, given the SHA-256 `sha256`:
 * {bytes, name, at}: the pack (its table, then each file's bytes), its name, and where each file is in it.
 */
export function packOf(stored: Uint8Array[], sha256: Sha256): {bytes: Uint8Array; name: string; at: number[]} {
  const table = new Uint8Array(stored.length * LINE);
  stored.forEach((b, k) => table.set(sha256(b), k * LINE));
  const at: number[] = [];
  let end = table.length;
  for (const b of stored) { at.push(end); end += b.length; }
  const bytes = new Uint8Array(end);
  bytes.set(table, 0);
  stored.forEach((b, k) => bytes.set(b, at[k]));
  return {bytes, name: `${hex(sha256(table))}.pack`, at};
}

/** For each pack of `index`, each file it stores by where it is (`at`): {line, len}, its line of the table and length. */
export function entriesOf(index: Packed): Map<number, {line: number; len: number}>[] {
  const lens = index.packs.map(() => new Map<number, number>());
  for (const f of index.files) if (f.len) lens[f.pack].set(f.at, f.len);
  return lens.map((m) => new Map([...m].sort((a, b) => a[0] - b[0]).map(([at, len], line) => [at, {line, len}])));
}

/** Throws unless `table` is the table of the pack named `name`. */
export function checkTable(table: Uint8Array, name: string, sha256: Sha256): void {
  if (`${hex(sha256(table))}.pack` !== name) throw new Error(`root: packs/${name} does not begin with the table it is named by`);
}

/** Throws unless `bytes`, read at line `line` of the pack named `name`, are what its `table` says. */
export function checkFile(bytes: Uint8Array, table: Uint8Array, line: number | undefined, name: string, sha256: Sha256): void {
  if (line === undefined || !same(sha256(bytes), table.subarray(line * LINE, (line + 1) * LINE))) {
    throw new Error(`root: what packs/${name} gave is not the file its table names`);
  }
}

/**
 * Every pack of `index` as `read(name, at, len)` gives it, checked whole: its table against its name, each file it
 * stores against its line, and nothing in it besides (its files one after another from the table's end to its own,
 * `size(name)` bytes, as many as the index says). What a release is checked by before it is published or taken in.
 */
export function checkPacks(index: Packed, read: (name: string, at: number, len: number) => Uint8Array, size: (name: string) => number, sha256: Sha256): void {
  entriesOf(index).forEach((entries, k) => {
    const {name, bytes} = index.packs[k];
    if (size(name) !== bytes) throw new Error(`root: packs/${name} is ${size(name)} bytes, its index says ${bytes}`);
    const table = read(name, 0, entries.size * LINE);
    checkTable(table, name, sha256);
    let end = table.length;
    for (const [at, {line, len}] of entries) {
      if (at !== end) throw new Error(`root: packs/${name} holds bytes no file of its index is (at ${end})`);
      checkFile(read(name, at, len), table, line, name, sha256);
      end += len;
    }
    if (end !== bytes) throw new Error(`root: packs/${name} holds bytes no file of its index is (from ${end})`);
  });
}

/**
 * `range(name, at, len)` (a pack's bytes, as a Range request or a read gives them) as the files of `index` are read
 * from it, checked: `read(k, at, len)` gives the bytes of the file at `at` of the `k`th pack once they are what that
 * pack's table says, each table fetched once and checked against its pack's name.
 */
export function checkedRange(index: Packed, range: (name: string, at: number, len: number) => Uint8Array, sha256: Sha256): (pack: number, at: number, len: number) => Uint8Array {
  const entries = entriesOf(index);
  const tables = new Map<number, Uint8Array>();
  const tableOf = (k: number): Uint8Array => {
    if (!tables.has(k)) {
      const {name} = index.packs[k];
      const table = range(name, 0, entries[k].size * LINE);
      checkTable(table, name, sha256);
      tables.set(k, table);
    }
    return tables.get(k)!;
  };
  return (k, at, len) => {
    if (!len) return new Uint8Array(0);
    const {name} = index.packs[k];
    const bytes = range(name, at, len);
    checkFile(bytes, tableOf(k), entries[k].get(at)?.line, name, sha256);
    return bytes;
  };
}
