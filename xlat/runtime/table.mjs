// What makes a file read from a pack alone (one Range of it) as checked as the whole pack would be. A pack begins with
// its table: the SHA-256 of each file it stores (its bytes as stored: zstd frames, or as it is), one 32-byte line
// each, in the order the files are in it; and the pack is named by the SHA-256 of its table. A file's bytes are
// checked against its line, the table against the pack's name, and the name is the index's, which is checked against
// the digest a release pins: so nothing read from a pack is used before it is known to be the root's. The writer
// (os/scripts/l3.ts), every reader (pack.mjs, ahead.mjs, os/scripts/l3-tree.ts, os/scripts/prompt-files.ts) and
// their tests take this one account of it. `sha256(bytes)` gives the 32 bytes of a digest: the translator's in a
// browser (where a system call must have the bytes at once), node's elsewhere.

/** Bytes of a line of a table. */
export const LINE = 32;

const hex = (d) => Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * A pack of `stored` (each file's bytes as it is to be stored, none empty), in that order, given the SHA-256 `sha256`:
 * {bytes, name, at}: the pack (its table, then each file's bytes), its name, and where each file is in it.
 */
export function packOf(stored, sha256) {
  const table = new Uint8Array(stored.length * LINE);
  stored.forEach((b, k) => table.set(sha256(b), k * LINE));
  const at = [];
  let end = table.length;
  for (const b of stored) { at.push(end); end += b.length; }
  const bytes = new Uint8Array(end);
  bytes.set(table, 0);
  stored.forEach((b, k) => bytes.set(b, at[k]));
  return {bytes, name: `${hex(sha256(table))}.pack`, at};
}

/** For each pack of `index`, each file it stores by where it is (`at`): {line, len}, its line of the table and length. */
export function entriesOf(index) {
  const lens = index.packs.map(() => new Map());
  for (const f of index.files) if (f.len) lens[f.pack].set(f.at, f.len);
  return lens.map((m) => new Map([...m].sort((a, b) => a[0] - b[0]).map(([at, len], line) => [at, {line, len}])));
}

/** Throws unless `table` is the table of the pack named `name`. */
export function checkTable(table, name, sha256) {
  if (`${hex(sha256(table))}.pack` !== name) throw new Error(`root: packs/${name} does not begin with the table it is named by`);
}

/** Throws unless `bytes`, read at line `line` of the pack named `name`, are what its `table` says. */
export function checkFile(bytes, table, line, name, sha256) {
  if (line === undefined || !same(sha256(bytes), table.subarray(line * LINE, (line + 1) * LINE))) {
    throw new Error(`root: what packs/${name} gave is not the file its table names`);
  }
}

/**
 * Every pack of `index` as `read(name, at, len)` gives it, checked whole: its table against its name, each file it
 * stores against its line, and nothing in it besides (its files one after another from the table's end to its own,
 * `size(name)` bytes, as many as the index says). What a release is checked by before it is published or taken in.
 */
export function checkPacks(index, read, size, sha256) {
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
export function checkedRange(index, range, sha256) {
  const entries = entriesOf(index);
  const tables = new Map();
  const tableOf = (k) => {
    if (!tables.has(k)) {
      const {name} = index.packs[k];
      const table = range(name, 0, entries[k].size * LINE);
      checkTable(table, name, sha256);
      tables.set(k, table);
    }
    return tables.get(k);
  };
  return (k, at, len) => {
    if (!len) return new Uint8Array(0);
    const bytes = range(index.packs[k].name, at, len);
    checkFile(bytes, tableOf(k), entries[k].get(at)?.line, index.packs[k].name, sha256);
    return bytes;
  };
}
