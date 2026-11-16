import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Kernel} from '../../runtime/linux/process.ts';
import {File, Vfs} from '../../runtime/linux/fs.ts';

// What a kernel holds of its files' bytes, and what it lets go (Kernel.held, Kernel.free): a tree's own. Each test is
// one finding closed; the numbers in the names are the issues'.

const kernel = (vfs?: Vfs): Kernel => new Kernel({vfs, translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
/** A file of `n` bytes that come from its loader, and how often the loader was asked. */
function lazy(n: number): {file: File; reads: () => number} {
  let reads = 0;
  return {file: new File(new Uint8Array(0), 0o644, () => { reads++; return new Uint8Array(n).fill(7); }), reads: () => reads};
}
/** `node`'s translation, as a kernel keeps one (of `size` bytes, kept from an earlier run). */
const translation = (size: number) => ({version: 0, image: {size}, used: 0, kept: true}) as unknown as Parameters<Kernel['remember']>[1];

test('#117: two kernels on trees of their own count and let go each its own files: one freed, the other keeps its bytes', () => {
  const a = kernel(), b = kernel(), fa = lazy(3), fb = lazy(5);
  a.vfs.root.entries.set('a', fa.file);
  b.vfs.root.entries.set('b', fb.file);
  void fa.file.data;
  void fb.file.data;
  // (Before: both said 8, the two together.)
  assert.deepEqual([a.held().files, b.held().files], [3, 5]);
  a.free();
  // A's went back to its loader; B's is where it was, and its loader is not asked again.
  assert.deepEqual([fa.file._data.length, fa.file.load !== null, a.held().files], [0, true, 0]);
  assert.deepEqual([fb.file._data.length, fb.file.load, b.held().files], [5, null, 5]);
  void fb.file.data;
  assert.equal(fb.reads(), 1);
  // What was let go is read again when it is wanted, and held again.
  assert.equal(fa.file.data.length, 3);
  assert.deepEqual([fa.reads(), a.held().files], [2, 3]);
});

test('#117: a file is its tree\'s wherever in it it lies, however it came there; one written is nobody\'s to let go', () => {
  const k = kernel(), deep = lazy(4), moved = lazy(6), linked = lazy(2), written = lazy(9);
  // Put in a folder before the folder is in the tree; moved from one folder to another; under two names.
  const dir = k.vfs.mkdirp('/x/y');
  dir.entries.set('deep', deep.file);
  k.vfs.mkdirp('/from').entries.set('m', moved.file);
  k.vfs.mkdirp('/to').entries.set('m', moved.file);
  k.vfs.dir('/from').entries.delete('m');
  k.vfs.root.entries.set('l1', linked.file);
  k.vfs.dir('/x').entries.set('l2', linked.file);
  k.vfs.root.entries.delete('l1');
  k.vfs.root.entries.set('w', written.file);
  for (const f of [deep, moved, linked, written]) void f.file.data;
  assert.equal(k.held().files, 4 + 6 + 2 + 9);
  // Written, its bytes are its own: not counted among those a loader can give again, and not let go.
  written.file.write(0, new Uint8Array([1]));
  assert.equal(k.held().files, 4 + 6 + 2);
  k.free();
  assert.deepEqual([deep, moved, linked].map((f) => f.file._data.length), [0, 0, 0]);
  assert.deepEqual([written.file._data.length, written.file.data[0], written.reads()], [9, 1, 1]);
  assert.equal(k.held().files, 0);
  // One that lies in no tree is held by none.
  const loose = lazy(8);
  void loose.file.data;
  assert.equal(k.held().files, 0);
});

test('#117: kernels on one tree share its files: what one still reads the other does not let go, until the one ends', () => {
  const vfs = new Vfs(), a = kernel(vfs), b = kernel(vfs), program = lazy(5), other = lazy(3);
  vfs.root.entries.set('program', program.file);
  vfs.root.entries.set('other', other.file);
  void program.file.data;
  void other.file.data;
  // Both see the tree's files; with no translation, neither keeps any.
  assert.deepEqual([a.held().files, b.held().files, vfs.loaded.keepers.size], [8, 8, 0]);
  // B has a translation of the program: its file is B's source, and not spare to A either.
  b.remember(program.file, translation(100));
  assert.equal(vfs.loaded.keepers.has(b), true);
  assert.equal(a.held().spare, 3);
  a.free();
  assert.deepEqual([program.file._data.length, program.reads(), other.file._data.length], [5, 1, 0]);
  // B ended: it keeps nothing any longer, and the tree does not keep it.
  b.halt();
  assert.equal(vfs.loaded.keepers.size, 0);
  a.free();
  assert.equal(program.file._data.length, 0);
});

test('#117: kernels made and ended over and over leave nothing behind on the tree they ran on, and none on a tree gone', () => {
  const vfs = new Vfs(), f = lazy(4);
  vfs.root.entries.set('f', f.file);
  for (let n = 0; n < 50; n++) {
    const k = kernel(vfs);
    void f.file.data;
    k.remember(f.file, translation(10));
    assert.equal(vfs.loaded.keepers.size, 1);
    k.halt();
  }
  // None of them is kept by the tree, and none keeps the file: the next kernel on the tree lets it go.
  assert.deepEqual([vfs.loaded.keepers.size, vfs.loaded.files.size], [0, 1]);
  kernel(vfs).free();
  assert.deepEqual([vfs.loaded.files.size, f.file._data.length, f.reads()], [0, 0, 1]);
  // A tree of its own holds its files itself (nothing outside it does): with the tree, they go.
  const own = kernel(), g = lazy(4);
  own.vfs.root.entries.set('g', g.file);
  void g.file.data;
  assert.deepEqual([...own.vfs.loaded.files], [g.file]);
  assert.equal(vfs.loaded.files.has(g.file), false);
});
