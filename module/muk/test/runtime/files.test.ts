import assert from 'node:assert/strict';
import {test} from 'node:test';
// The runtime loads its call tables through process.ts, as the worker does.
import {Kernel, Process} from '../../runtime/process.ts';
import {Dir, Link} from '../../runtime/fs.ts';
import {Mirror} from '../../runtime/mirror.ts';

// The files' edges, each as a guest's own calls on a kernel and a page of memory (no program translated): what a
// call that Linux refuses leaves behind (nothing), and what one it takes changes (one thing). Each test is one
// finding closed; the numbers in the names are the issues'. What Linux says to each was asked of Linux.

const RENAME = 82, RENAMEAT2 = 316, OPEN = 2, PREAD = 17, LINK = 86, UNLINK = 87, RMDIR = 84, UNLINKAT = 263, STAT = 4, LSTAT = 6, SYMLINK = 88;
const AT_FDCWD = -100, NOREPLACE = 1, EXCHANGE = 2;
const ENOENT = -2n, EBUSY = -16n, EEXIST = -17n, ENOTDIR = -20n, EISDIR = -21n, EINVAL = -22n, ENOTEMPTY = -39n;
const AT_REMOVEDIR = 0x200;
const enc = new TextEncoder(), dec = new TextDecoder();

function guest(): Process {
  const kernel = new Kernel({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(kernel, null);
  p.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  return p;
}
const call = (p: Process, nr: number, ...args: (number | bigint)[]): bigint =>
  p.syscall(BigInt(nr), ...([...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]));
/** `text` as a C string in the guest's memory at `at`: its address. */
function at(p: Process, where: number, text: string): number {
  const bytes = enc.encode(text);
  p.bytes.set(bytes, where);
  p.bytes[where + bytes.length] = 0;
  return where;
}
const rename = (p: Process, from: string, to: string): bigint => call(p, RENAME, at(p, 1024, from), at(p, 2048, to));
const rename2 = (p: Process, from: string, to: string, flags: number): bigint =>
  call(p, RENAMEAT2, AT_FDCWD, at(p, 1024, from), AT_FDCWD, at(p, 2048, to), flags);
const text = (p: Process, path: string): string => dec.decode(p.kernel.vfs.readFile(path));
/** Everything under `path`, a line each: a folder with how many links it has, a file with its links and its text. */
function tree(p: Process, path = '/t'): string[] {
  const out: string[] = [];
  const walk = (dir: Dir, prefix: string) => {
    for (const [name, node] of [...dir.entries].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const where = `${prefix}/${name}`;
      if (node instanceof Dir) { out.push(`${where}/ ${node.nlink}`); walk(node, where); }
      else if (node instanceof Link) out.push(`${where} -> ${node.target}`);
      else out.push(`${where} ${node.nlink} ${JSON.stringify(text(p, where))}`);
    }
  };
  const top = p.kernel.vfs.lookup(path, '/') as Dir;
  out.push(`${path}/ ${top.nlink}`);
  walk(top, path);
  return out;
}
/** A guest with /t: a (a file), b (a file), d/ (holding e/ holding keep), empty/ and full/ (holding x). */
function laid(): Process {
  const p = guest(), v = p.kernel.vfs;
  v.writeFile('/t/a', enc.encode('source'));
  v.writeFile('/t/b', enc.encode('destination'));
  v.writeFile('/t/d/e/keep', enc.encode('contents'));
  v.mkdirp('/t/empty');
  v.writeFile('/t/full/x', enc.encode('x'));
  return p;
}

test('#98: a rename Linux refuses changes nothing: not the names, their links, what is open of them, nor what the mirror tells', () => {
  const p = laid(), before = tree(p), mirror = new Mirror(p.kernel.vfs, '/t');
  const fd = Number(call(p, OPEN, at(p, 1024, '/t/b'), 0));
  const refused: [string, bigint, () => bigint][] = [
    ['NOREPLACE onto a name that is there', EEXIST, () => rename2(p, '/t/a', '/t/b', NOREPLACE)],
    ['EXCHANGE with a name that is not there', ENOENT, () => rename2(p, '/t/a', '/t/none', EXCHANGE)],
    ['a flag there is none of', EINVAL, () => rename2(p, '/t/a', '/t/b', 8)],
    ['NOREPLACE and EXCHANGE at once', EINVAL, () => rename2(p, '/t/a', '/t/b', NOREPLACE | EXCHANGE)],
    ['a folder into itself', EINVAL, () => rename(p, '/t/d', '/t/d/d')],
    ['a folder under itself', EINVAL, () => rename(p, '/t/d', '/t/d/e/d')],
    ['a folder swapped with one it holds', EINVAL, () => rename2(p, '/t/d', '/t/d/e', EXCHANGE)],
    ['a folder onto a file', ENOTDIR, () => rename(p, '/t/d', '/t/b')],
    ['a file onto a folder', EISDIR, () => rename(p, '/t/a', '/t/empty')],
    ['a folder onto one that is not empty', ENOTEMPTY, () => rename(p, '/t/d', '/t/full')],
    ['a folder onto the one that holds it', ENOTEMPTY, () => rename(p, '/t/d/e', '/t/d')],
    ['a name that is not there', ENOENT, () => rename(p, '/t/none', '/t/b')],
  ];
  for (const [what, said, ask] of refused) {
    assert.equal(ask(), said, what);
    assert.deepEqual(tree(p), before, what);
    assert.equal(mirror.changes(), null, what);
  }
  assert.equal(call(p, PREAD, fd, 4096, 64, 0), 11n);
  assert.equal(dec.decode(p.bytes.subarray(4096, 4107)), 'destination');
});

test('#98: a rename taken is one change: over what was there, onto an empty folder, between folders, swapped; the same file by two names is left', () => {
  // Over a file: the old name gone, the new one the file moved, what was there gone.
  let p = laid();
  assert.equal(rename(p, '/t/a', '/t/b'), 0n);
  assert.deepEqual(tree(p), ['/t/ 5', '/t/b 1 "source"', '/t/d/ 3', '/t/d/e/ 2', '/t/d/e/keep 1 "contents"', '/t/empty/ 2', '/t/full/ 2', '/t/full/x 1 "x"']);
  // NOREPLACE onto a free name is a rename.
  assert.equal(rename2(p, '/t/b', '/t/c', NOREPLACE), 0n);
  assert.equal(text(p, '/t/c'), 'source');

  // A folder onto an empty one, and into another: each parent counts the folders it holds.
  p = laid();
  assert.equal(rename(p, '/t/d', '/t/empty'), 0n);
  assert.deepEqual(tree(p), ['/t/ 4', '/t/a 1 "source"', '/t/b 1 "destination"', '/t/empty/ 3', '/t/empty/e/ 2', '/t/empty/e/keep 1 "contents"', '/t/full/ 2', '/t/full/x 1 "x"']);
  assert.equal(rename(p, '/t/empty/e', '/t/full/e'), 0n);
  assert.deepEqual(tree(p).filter((l) => l.endsWith(' 2') || l.endsWith(' 3') || l.endsWith(' 4')), ['/t/ 4', '/t/empty/ 2', '/t/full/ 3', '/t/full/e/ 2']);

  // EXCHANGE: the two swapped, nothing lost; a file with a folder of another parent, their parents' counts with them.
  p = laid();
  assert.equal(rename2(p, '/t/a', '/t/b', EXCHANGE), 0n);
  assert.deepEqual([text(p, '/t/a'), text(p, '/t/b')], ['destination', 'source']);
  assert.equal(rename2(p, '/t/a', '/t/d/e', EXCHANGE), 0n);
  assert.deepEqual(tree(p), ['/t/ 6', '/t/a/ 2', '/t/a/keep 1 "contents"', '/t/b 1 "source"', '/t/d/ 2', '/t/d/e 1 "destination"', '/t/empty/ 2', '/t/full/ 2', '/t/full/x 1 "x"']);

  // The same path, and the same file by two names: nothing changes, both names stay.
  p = laid();
  assert.equal(call(p, LINK, at(p, 1024, '/t/a'), at(p, 2048, '/t/again')), 0n);
  const before = tree(p);
  assert.equal(rename(p, '/t/a', '/t/a'), 0n);
  assert.equal(rename(p, '/t/a', '/t/again'), 0n);
  assert.deepEqual(tree(p), before);

  // What the mirror tells of a folder moved: it gone where it was, and what is where it went.
  p = laid();
  const mirror = new Mirror(p.kernel.vfs, '/t');
  assert.equal(rename(p, '/t/d', '/t/empty'), 0n);
  const c = mirror.changes()!;
  assert.deepEqual([c.removed.sort(), c.dirs.sort(), c.files.map((f) => f.path)], [['d'], ['empty/e'], ['empty/e/keep']]);
});

test('#99: a path that ends with a slash, "." or ".." takes away nothing Linux would not: each refusal as Linux says it, nothing changed', () => {
  const p = laid(), v = p.kernel.vfs;
  // Links: to a folder, to a file, and to nothing.
  assert.equal(call(p, SYMLINK, at(p, 1024, 'd'), at(p, 2048, '/t/to-d')), 0n);
  assert.equal(call(p, SYMLINK, at(p, 1024, 'a'), at(p, 2048, '/t/to-a')), 0n);
  assert.equal(call(p, SYMLINK, at(p, 1024, 'none'), at(p, 2048, '/t/to-none')), 0n);
  const before = tree(p), mirror = new Mirror(v, '/t');
  const names = () => [...(v.lookup('/t', '/') as Dir).entries.keys()].sort().join(' ');
  const had = names();
  const unlink = (path: string) => call(p, UNLINK, at(p, 1024, path));
  const rmdir = (path: string) => call(p, RMDIR, at(p, 1024, path));
  const unlinkat = (path: string, flags: number) => call(p, UNLINKAT, AT_FDCWD, at(p, 1024, path), flags);
  const refused: [string, bigint, () => bigint][] = [
    ['unlink of a file with a slash', ENOTDIR, () => unlink('/t/a/')],
    ['unlink of a folder with a slash', EISDIR, () => unlink('/t/empty/')],
    ['unlink of a link to a folder with a slash', ENOTDIR, () => unlink('/t/to-d/')],
    ['unlink of a link to nothing with a slash', ENOTDIR, () => unlink('/t/to-none/')],
    ['unlink of a name not there with a slash', ENOENT, () => unlink('/t/none/')],
    ['unlink of a folder\'s "."', EISDIR, () => unlink('/t/empty/.')],
    ['unlink of a folder\'s ".."', EISDIR, () => unlink('/t/empty/..')],
    ['unlink through a file', ENOTDIR, () => unlink('/t/a/.')],
    ['unlinkat of a file with a slash', ENOTDIR, () => unlinkat('/t/a/', 0)],
    ['rmdir of a folder\'s "."', EINVAL, () => rmdir('/t/empty/.')],
    ['rmdir of a folder\'s ".."', ENOTEMPTY, () => rmdir('/t/empty/..')],
    ['rmdir of a file with a slash', ENOTDIR, () => rmdir('/t/a/')],
    ['rmdir of a link to a folder with a slash', ENOTDIR, () => rmdir('/t/to-d/')],
    ['rmdir of the root', EBUSY, () => rmdir('/')],
    ['unlinkat of a folder\'s "." as a folder', EINVAL, () => unlinkat('/t/empty/.', AT_REMOVEDIR)],
    ['rename of a file with a slash', ENOTDIR, () => rename(p, '/t/a/', '/t/c')],
    ['rename of a file to a name with a slash', ENOTDIR, () => rename(p, '/t/a', '/t/c/')],
    ['rename of a folder\'s "."', EBUSY, () => rename(p, '/t/empty/.', '/t/c')],
    ['rename onto a folder\'s ".."', EBUSY, () => rename(p, '/t/empty', '/t/d/..')],
  ];
  for (const [what, said, ask] of refused) {
    assert.equal(ask(), said, what);
    assert.equal(names(), had, what);
    assert.deepEqual(tree(p), before, what);
    assert.equal(mirror.changes(), null, what);
  }
  // The walk says the same to those who only look: through a file is ENOTDIR; a folder, or a link to one, is gone through.
  const stat = (path: string) => call(p, STAT, at(p, 1024, path), 8192), lstat = (path: string) => call(p, LSTAT, at(p, 1024, path), 8192);
  for (const path of ['/t/a/', '/t/a/.', '/t/a/..', '/t/to-a/']) {
    assert.equal(stat(path), ENOTDIR, path);
    assert.equal(lstat(path), ENOTDIR, path);
    assert.equal(call(p, OPEN, at(p, 1024, path), 0), ENOTDIR, path);
  }
  for (const path of ['/t/d/', '/t/d/.', '/t/d/e/..', '/t/to-d/', '/t/to-d/.']) {
    assert.equal(stat(path), 0n, path);
    assert.equal(lstat(path), 0n, path);
    // A folder, whoever asks: st_mode's type is S_IFDIR.
    assert.equal(p.view.getUint32(8192 + 24, true) & 0o170000, 0o040000, path);
  }
  // And what Linux takes is taken: a folder by its name with a slash, a link by its name.
  assert.equal(rmdir('/t/empty/'), 0n);
  assert.equal(unlink('/t/to-d'), 0n);
  assert.equal(rename(p, '/t/d/', '/t/moved/'), 0n);
  assert.equal(text(p, '/t/moved/e/keep'), 'contents');
});
