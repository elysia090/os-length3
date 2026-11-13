import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {mountPack, type MountTarget} from '../../runtime/mount.ts';
import {fetchStored, syncRange} from '../../runtime/pack.ts';
import {packOf} from '../../runtime/table.ts';

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(bytes).digest());
const content = new TextEncoder().encode('one file, two names');
const pack = packOf([content], sha256);

test('an image mounts through supplied file operations, without a Linux filesystem or translator', () => {
  type Lazy = {read(): Uint8Array; origin: string};
  const files = new Map<string, Lazy>();
  const dirs: string[] = [], links: string[] = [], reads: number[] = [];
  files.set('/usr/bin/preserved', {read: () => new Uint8Array([7]), origin: 'caller'});
  const target: MountTarget<Lazy> = {
    directory(path, mode) { dirs.push(path); assert.equal(mode, 0o755); },
    has: (path) => files.has(path),
    symlink(target, path) { links.push(`${path}=${target}`); },
    file(path, mode, size, read, origin) {
      assert.equal(mode, 0o755); assert.equal(size, content.length);
      const file = {read, origin}; files.set(path, file); return file;
    },
    hardlink(file, path) { files.set(path, file); },
  };
  mountPack(target, {
    codec: 'zstd', packs: [{name: pack.name, bytes: pack.bytes.length}],
    dirs: [{path: '/usr/bin', mode: 0o755}], links: [{path: '/bin', target: 'usr/bin'}],
    files: ['one', 'two', 'preserved'].map((name) => ({path: `/usr/bin/${name}`, mode: 0o755, size: content.length,
      pack: 0, at: pack.at[0], len: content.length, raw: true})),
  }, {range: (_, at, len) => { reads.push(at); return pack.bytes.slice(at, at + len); }, decode() { throw new Error('raw file decoded'); }, sha256});
  assert.deepEqual(reads, [], 'mounting reads no file bytes');
  assert.deepEqual(dirs, ['/usr/bin']); assert.deepEqual(links, ['/bin=usr/bin']);
  assert.equal(files.get('/usr/bin/one'), files.get('/usr/bin/two'));
  assert.equal(files.get('/usr/bin/preserved')?.origin, 'caller');
  assert.deepEqual(files.get('/usr/bin/two')?.read(), content);
  assert.match(files.get('/usr/bin/one')!.origin, /^[0-9a-f]{64}_32_/);
});

test('range transport is supplied: ranged and whole responses agree, errors stay errors', async () => {
  const asked: string[] = [];
  for (const status of [200, 206]) {
    const read = syncRange('https://root.example/', (url, at, len) => {
      asked.push(url); return {status, bytes: status === 200 ? pack.bytes : pack.bytes.slice(at, at + len)};
    });
    assert.deepEqual(read(pack.name, pack.at[0], content.length), content);
    assert.deepEqual(read(pack.name, 0, 0), new Uint8Array(0));
    const bytes = await fetchStored({url: 'https://root.example/', pack: pack.name,
      at: pack.at[0], len: content.length, lines: 1, line: 0}, sha256, async (url, at, len) => {
      assert.equal(url, `https://root.example/packs/${pack.name}`);
      return {status, bytes: status === 200 ? pack.bytes : pack.bytes.slice(at, at + len)};
    });
    assert.deepEqual(bytes, content);
  }
  assert.equal(asked.length, 2, 'empty ranges do not ask the host');
  assert.throws(() => syncRange('https://root.example/', () => ({status: 404, bytes: new Uint8Array(0)}))(pack.name, 0, 1), /answered 404/);
  await assert.rejects(fetchStored({url: 'https://root.example/', pack: pack.name, at: pack.at[0], len: content.length, lines: 1, line: 0},
    sha256, async () => ({status: 206, bytes: new Uint8Array(32)})), /not the file|does not begin/);
});
