import assert from 'node:assert/strict';
import {test} from 'node:test';
import {File, Vfs, mountTarget} from '../../runtime/linux/fs.ts';

test('a new file has its bytes and mode when published', () => {
  const vfs = new Vfs();
  const dir = vfs.mkdirp('/new'), set = dir.entries.set.bind(dir.entries);
  dir.entries.set = (name, inode) => {
    assert.equal(name, 'file');
    assert.ok(inode instanceof File);
    assert.deepEqual(inode.bytes(), Uint8Array.of(3, 7));
    assert.equal(inode.mode & 0o7777, 0o640);
    return set(name, inode);
  };
  assert.equal(vfs.writeFile('/new/file', Uint8Array.of(3, 7), 0o640), vfs.file('/new/file'));
});

test('a rejected publication reports the original failure and creates no file', () => {
  const vfs = new Vfs(), failure = new Error('publication refused');
  const dir = vfs.mkdirp('/new');
  dir.entries.set = () => { throw failure; };
  assert.throws(() => vfs.writeFile('/new/file', 'data'), error => error === failure);
  assert.equal(dir.entries.has('file'), false);
});

test('mounting publishes size and origin without materializing payload', () => {
  const vfs = new Vfs();
  let reads = 0;
  const file = mountTarget(vfs).file('/file', 0o644, 1, () => { reads++; return Uint8Array.of(7); }, 'origin');
  assert.equal(vfs.file('/file'), file);
  assert.equal(file.size, 1);
  assert.equal(file.origin, 'origin');
  assert.equal(reads, 0);
  assert.deepEqual(file.bytes(), Uint8Array.of(7));
  assert.equal(reads, 1);
});
