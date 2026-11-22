import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {mountPack, type MountTarget} from '../../format/mount.ts';
import {fetchStored, syncRange, type Ranged} from '../pack-range.ts';
import {LINE, packOf} from '../../format/pack.ts';

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
    sha256, async () => ({status: 206, bytes: new Uint8Array(32)})), /wrong pack response length/);
});

const tail = Uint8Array.of(8, 9), pair = packOf([content, tail], sha256);
const first = {url: 'https://root.example/', pack: pair.name, at: pair.at[0], len: content.length, lines: 2, line: 0};

test('an adjacent table and file use one exact request on both 206 and whole 200 servers', async () => {
  for (const status of [206, 200]) {
    const calls: [number, number][] = [];
    const bytes = await fetchStored(first, sha256, async (url, at, len) => {
      assert.equal(url, first.url + 'packs/' + pair.name);
      calls.push([at, len]);
      return {status, bytes: status === 206 ? pair.bytes.slice(at, at + len) : pair.bytes};
    });
    assert.deepEqual(calls, [[0, first.at + first.len]]);
    assert.deepEqual(bytes, content, 'the second file is outside this payload');
    assert.equal(bytes.buffer.byteLength, status === 206 ? first.at + first.len : pair.bytes.length);
  }
});

test('each half of a joined response still has its own authentication', async () => {
  for (const [offset, error] of [[0, /does not begin with the table/], [first.at, /not the file its table names/]] as const) {
    const other = pair.bytes.slice(0, first.at + first.len);
    other[offset] ^= 1;
    await assert.rejects(fetchStored(first, sha256, async () => ({status: 206, bytes: other})), error);
  }
});

test('gaps and wide tables keep the two exact requests in parallel', async () => {
  const lines = 129, wide = packOf([content, ...Array.from({length: lines - 1}, () => tail)], sha256);
  for (const [data, stored, want] of [
    [{...first, at: pair.at[1], len: tail.length, line: 1}, pair.bytes, tail],
    [{...first, pack: wide.name, at: wide.at[0], lines}, wide.bytes, content],
  ] as const) {
    for (const status of [206, 200]) {
      const calls: [number, number][] = [], release: (() => void)[] = [];
      const reading = fetchStored(data, sha256, (_, at, len) => new Promise<Ranged>((resolve) => {
        calls.push([at, len]);
        release.push(() => resolve({status, bytes: status === 206 ? stored.slice(at, at + len) : stored}));
      }));
      assert.deepEqual(calls, [[0, data.lines * LINE], [data.at, data.len]]);
      for (const finish of release) finish();
      const bytes = await reading;
      assert.deepEqual(bytes, want);
      if (status === 206) assert.equal(bytes.buffer.byteLength, want.length, 'do not hold a wide table with the file');
    }
  }
});

test('a width outside safe-integer addition is not combined', async () => {
  const len = Number.MAX_SAFE_INTEGER, calls: [number, number][] = [];
  await assert.rejects(fetchStored({...first, len}, sha256, async (_, at, width) => {
    calls.push([at, width]);
    return {status: 416, bytes: new Uint8Array(0)};
  }), /answered 416/);
  assert.deepEqual(calls, [[0, first.at], [first.at, len]]);
});
