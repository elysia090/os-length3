import assert from 'node:assert/strict';
import {test} from 'node:test';
// The runtime loads its call tables through process.ts, as the worker does.
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {Dir, Link} from '../../runtime/linux/fs.ts';
import {Mirror} from '../../runtime/linux/mirror.ts';

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

const TRUNCATE = 76, FTRUNCATE = 77, CLOSE = 3, MKNOD = 133, FALLOCATE = 285;
const EBADF = -9n, EFBIG = -27n, EMFILE = -24n, ELOOP = -40n;
const O_WRONLY = 1, O_RDWR = 2, O_CREAT = 0x40, O_EXCL = 0x80, O_TRUNC = 0x200, O_DIRECTORY = 0x10000, O_NOFOLLOW = 0x20000;

test('#103: truncate and ftruncate refuse what Linux refuses, in its order, and what is refused changes nothing', () => {
  const p = laid(), v = p.kernel.vfs;
  assert.equal(call(p, SYMLINK, at(p, 1024, 'a'), at(p, 2048, '/t/to-a')), 0n);
  assert.equal(call(p, MKNOD, at(p, 1024, '/tmp/fifo'), 0o010644, 0), 0n);
  const ro = Number(call(p, OPEN, at(p, 1024, '/t/a'), 0)), wo = Number(call(p, OPEN, at(p, 1024, '/t/a'), O_WRONLY)), rw = Number(call(p, OPEN, at(p, 1024, '/t/a'), O_RDWR));
  const dir = Number(call(p, OPEN, at(p, 1024, '/t/d'), O_DIRECTORY));
  const nul = Number(call(p, OPEN, at(p, 1024, '/dev/null'), O_WRONLY));
  assert.ok(ro >= 0 && wo >= 0 && rw >= 0 && dir >= 0 && nul >= 0);
  const file = v.lookup('/t/a', '/') as unknown as {size: number; version: number};
  const before = tree(p), mirror = new Mirror(v, '/t'), version = file.version;
  const truncate = (path: string, length: number | bigint) => call(p, TRUNCATE, at(p, 1024, path), length);
  const ftruncate = (fd: number, length: number | bigint) => call(p, FTRUNCATE, fd, length);
  // What Linux says to each (asked of it, on tmpfs): a negative length is EINVAL before the name or the descriptor is
  // looked at; a folder is EISDIR by its name and EINVAL by its descriptor; a descriptor not open for writing is EINVAL.
  const refused: [string, bigint, () => bigint][] = [
    ['truncate to -1', EINVAL, () => truncate('/t/a', -1)],
    ['truncate of a name not there to -1', EINVAL, () => truncate('/t/none', -1)],
    ['truncate of a folder to -1', EINVAL, () => truncate('/t/d', -1)],
    ['truncate of a name not there', ENOENT, () => truncate('/t/none', 0)],
    ['truncate of a folder', EISDIR, () => truncate('/t/d', 0)],
    ['truncate of a named pipe', EINVAL, () => truncate('/tmp/fifo', 0)],
    ['truncate of a device', EINVAL, () => truncate('/dev/null', 0)],
    ['truncate past what a file holds here', EFBIG, () => truncate('/t/a', 2 ** 31)],
    ['truncate to the largest length there is', EFBIG, () => truncate('/t/a', 2n ** 63n - 1n)],
    ['ftruncate of one open for reading to -1', EINVAL, () => ftruncate(ro, -1)],
    ['ftruncate of one open for reading to 0', EINVAL, () => ftruncate(ro, 0)],
    ['ftruncate of one open for writing to -1', EINVAL, () => ftruncate(wo, -1)],
    ['ftruncate of no descriptor to -1', EINVAL, () => ftruncate(99, -1)],
    ['ftruncate of no descriptor', EBADF, () => ftruncate(99, 0)],
    ['ftruncate of a folder', EINVAL, () => ftruncate(dir, 0)],
    ['ftruncate of a device', EINVAL, () => ftruncate(nul, 0)],
    ['ftruncate past what a file holds here', EFBIG, () => ftruncate(wo, 2 ** 31)],
    ['fallocate past what a file holds here', EFBIG, () => call(p, FALLOCATE, wo, 0, 0, 2 ** 31)],
  ];
  for (const [what, said, ask] of refused) {
    assert.equal(ask(), said, what);
    assert.deepEqual(tree(p), before, what);
    assert.equal(file.size, 6, what);
    assert.equal(file.version, version, what);
    assert.equal(mirror.changes(), null, what);
  }
  // What it takes: cut, grown with zeros, through a link, by a descriptor open for writing or for both.
  assert.equal(truncate('/t/a', 3), 0n);
  assert.equal(text(p, '/t/a'), 'sou');
  assert.equal(truncate('/t/to-a', 5), 0n);
  assert.equal(text(p, '/t/a'), 'sou\0\0');
  assert.equal(ftruncate(wo, 2), 0n);
  assert.equal(text(p, '/t/a'), 'so');
  assert.equal(ftruncate(rw, 4), 0n);
  assert.equal(text(p, '/t/a'), 'so\0\0');
  assert.equal(truncate('/t/a', 0), 0n);
  assert.equal(file.size, 0);
  for (const fd of [ro, wo, rw, dir, nul]) assert.equal(call(p, CLOSE, fd), 0n);
});

test('#102: an open with no descriptor left is EMFILE whatever it names, and makes and empties nothing', () => {
  const p = laid(), v = p.kernel.vfs;
  assert.equal(call(p, SYMLINK, at(p, 1024, 'a'), at(p, 2048, '/t/to-a')), 0n);
  const held = Number(call(p, OPEN, at(p, 1024, '/t/a'), O_WRONLY));
  assert.ok(held >= 0);
  const before = tree(p), mirror = new Mirror(v, '/t'), file = v.lookup('/t/a', '/') as unknown as {version: number}, version = file.version;
  const slots = () => [...(p.fds as unknown as {slots: Map<number, unknown>}).slots.keys()].join(' ');
  const open = (path: string, flags: number) => call(p, OPEN, at(p, 1024, path), flags, 0o644);
  // No descriptor at or past the limit (RLIMIT_NOFILE's soft limit): none left.
  const limit = p.fds.limit, had = slots();
  p.fds.limit = 0;
  // What Linux says to each with RLIMIT_NOFILE 0 (asked of it): EMFILE, before the name is looked at.
  const asked: [string, () => bigint][] = [
    ['a file to be emptied', () => open('/t/a', O_WRONLY | O_TRUNC)],
    ['a file to be made', () => open('/t/new', O_WRONLY | O_CREAT)],
    ['a file there, to be made and no other', () => open('/t/a', O_WRONLY | O_CREAT | O_EXCL)],
    ['a name not there', () => open('/t/none', 0)],
    ['a file as a folder', () => open('/t/a', O_DIRECTORY)],
    ['a link not to be followed', () => open('/t/to-a', O_NOFOLLOW)],
    ['a descriptor by its /proc name, to be emptied', () => open(`/proc/self/fd/${held}`, O_WRONLY | O_TRUNC)],
  ];
  for (const [what, ask] of asked) {
    assert.equal(ask(), EMFILE, what);
    assert.deepEqual(tree(p), before, what);
    assert.equal(file.version, version, what);
    assert.equal(mirror.changes(), null, what);
    assert.equal(slots(), had, what);
  }
  // With room again each is what it is.
  p.fds.limit = limit;
  assert.equal(open('/t/none', 0), ENOENT);
  assert.equal(open('/t/a', O_WRONLY | O_CREAT | O_EXCL), EEXIST);
  assert.equal(open('/t/a', O_DIRECTORY), ENOTDIR);
  assert.equal(open('/t/to-a', O_NOFOLLOW), ELOOP);
  assert.deepEqual(tree(p), before);
  const made = Number(open('/t/new', O_WRONLY | O_CREAT));
  assert.ok(made >= 0);
  assert.equal(text(p, '/t/new'), '');
  const emptied = Number(open('/t/a', O_WRONLY | O_TRUNC));
  assert.ok(emptied >= 0);
  assert.equal(text(p, '/t/a'), '');
});

const OPENAT = 257, MKDIRAT = 258, FSTATAT = 262, RENAMEAT = 264, READLINK = 89, GETCWD = 79, CHDIR = 80, FCHDIR = 81, MKDIR = 83;

test('#100: a directory held open is that directory, however it or what is above it is renamed since; removed, nothing is in it', () => {
  const p = guest(), v = p.kernel.vfs;
  // (The one process there is, so that /proc's "self" is it.)
  p.pid = p.pgid = p.sid = 1;
  p.kernel.procs.set(1, p);
  v.writeFile('/a/file', enc.encode('original'));
  v.writeFile('/a/sub/deep', enc.encode('deep'));
  const open = (path: string, flags = 0) => call(p, OPEN, at(p, 1024, path), flags, 0o644);
  const openat = (dirfd: number, path: string, flags = 0) => call(p, OPENAT, dirfd, at(p, 1024, path), flags, 0o644);
  /** What the file `path` from `dirfd` holds, or the errno its open fails with. */
  const readAt = (dirfd: number, path: string): string | bigint => {
    const fd = openat(dirfd, path);
    if (fd < 0n) return fd;
    const n = Number(call(p, PREAD, fd, 4096, 64, 0));
    call(p, CLOSE, fd);
    return dec.decode(p.bytes.subarray(4096, 4096 + n));
  };
  const linked = (name: string): string | bigint => {
    const n = call(p, READLINK, at(p, 1024, name), 8192, 256);
    return n < 0n ? n : dec.decode(p.bytes.subarray(8192, 8192 + Number(n)));
  };
  const cwd = (): string | bigint => {
    const n = call(p, GETCWD, 8192, 256);
    return n < 0n ? n : dec.decode(p.bytes.subarray(8192, 8192 + Number(n) - 1));
  };
  const there = (path: string) => typeof v.find(path, '/') !== 'number';
  const d = Number(open('/a', O_DIRECTORY)), s = Number(open('/a/sub', O_DIRECTORY));
  assert.ok(d >= 0 && s >= 0);
  // What Linux does with each was asked of Linux (tmpfs).
  // Renamed: the same directory under its new name; one held under it too, and ".." from that one.
  assert.equal(rename(p, '/a', '/b'), 0n);
  assert.equal(readAt(d, 'file'), 'original');
  assert.equal(linked(`/proc/self/fd/${d}`), '/b');
  assert.equal(readAt(s, 'deep'), 'deep');
  assert.equal(readAt(s, '../file'), 'original');
  assert.equal(linked(`/proc/self/fd/${s}`), '/b/sub');
  // Its old name made again is another directory: what is held is still the first, for every call that takes it.
  v.writeFile('/a/file', enc.encode('replacement'));
  assert.equal(readAt(d, 'file'), 'original');
  assert.equal(call(p, MKDIRAT, d, at(p, 1024, 'new'), 0o755), 0n);
  assert.deepEqual([there('/b/new'), there('/a/new')], [true, false]);
  assert.equal(call(p, FSTATAT, d, at(p, 1024, 'file'), 8192, 0), 0n);
  assert.equal(p.view.getBigInt64(8192 + 48, true), 8n);
  assert.equal(call(p, RENAMEAT, d, at(p, 1024, 'sub'), d, at(p, 2048, 'sub2')), 0n);
  assert.deepEqual([there('/b/sub2'), there('/a/sub2')], [true, false]);
  assert.equal(linked(`/proc/self/fd/${s}`), '/b/sub2');
  assert.equal(call(p, UNLINKAT, d, at(p, 1024, 'file'), 0), 0n);
  assert.deepEqual([there('/b/file'), text(p, '/a/file')], [false, 'replacement']);
  // A path from the root does not look at the directory given.
  assert.equal(readAt(d, '/a/file'), 'replacement');
  // Gone to (fchdir), it is where the process works, and stays so renamed again.
  assert.equal(call(p, FCHDIR, d), 0n);
  assert.equal(cwd(), '/b');
  assert.equal(linked('/proc/self/cwd'), '/b');
  assert.equal(rename(p, '/b', '/c'), 0n);
  assert.equal(cwd(), '/c');
  assert.equal(readAt(AT_FDCWD, 'sub2/deep'), 'deep');
  // Removed while held and worked in: nothing is in it and nothing is made in it, though its old name is made again;
  // it is still itself ("."), and ".." is where it lay.
  assert.equal(call(p, MKDIR, at(p, 1024, '/gone'), 0o755), 0n);
  const g = Number(open('/gone', O_DIRECTORY));
  assert.equal(call(p, CHDIR, at(p, 1024, '/gone')), 0n);
  assert.equal(call(p, RMDIR, at(p, 1024, '/gone')), 0n);
  v.writeFile('/gone/x', enc.encode('new'));
  for (const from of [g, AT_FDCWD]) {
    assert.equal(openat(from, 'x'), ENOENT, `${from}`);
    assert.equal(openat(from, 'x', O_CREAT | O_WRONLY), ENOENT, `${from}`);
    assert.equal(call(p, MKDIRAT, from, at(p, 1024, 'm'), 0o755), ENOENT, `${from}`);
    assert.equal(call(p, FSTATAT, from, at(p, 1024, '.'), 8192, 0), 0n, `${from}`);
    const self = Number(openat(from, '.', O_DIRECTORY)), up = Number(openat(from, '..', O_DIRECTORY));
    assert.ok(self >= 0 && up >= 0, `${from}`);
    assert.equal(linked(`/proc/self/fd/${self}`), '/gone (deleted)', `${from}`);
    assert.equal(linked(`/proc/self/fd/${up}`), '/', `${from}`);
    call(p, CLOSE, self);
    call(p, CLOSE, up);
  }
  assert.equal(text(p, '/gone/x'), 'new');
  assert.equal(there('/gone/m'), false);
  assert.equal(linked(`/proc/self/fd/${g}`), '/gone (deleted)');
  assert.equal(cwd(), ENOENT);
  assert.equal(linked('/proc/self/cwd'), '/gone (deleted)');
  // Written over by a rename (an empty directory gives way to the one moved onto it): it is removed, as above.
  v.mkdirp('/dst');
  v.writeFile('/src/in', enc.encode('in src'));
  const h = Number(open('/dst', O_DIRECTORY));
  assert.equal(rename(p, '/src', '/dst'), 0n);
  assert.equal(readAt(h, 'in'), ENOENT);
  assert.equal(linked(`/proc/self/fd/${h}`), '/dst (deleted)');
  assert.equal(text(p, '/dst/in'), 'in src');
});
