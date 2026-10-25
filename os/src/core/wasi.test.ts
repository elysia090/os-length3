import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {buildCoreWasm, coreWasmPath, hasCargo} from '../../scripts/core-wasm.ts';
import {Core} from './abi.ts';
import {E, Exit, MemoryFS, WASI} from './wasi.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The preview1 calls as a module makes them: arguments in a memory of its own, answers written back into it.
function host(fs = new MemoryFS(), env: Record<string, string> = {}) {
  const memory = new WebAssembly.Memory({initial: 2});
  const wasi = new WASI({fs, env, out: (line, fd) => printed.push([fd, line])});
  const printed: [number, string][] = [];
  wasi.bind({exports: {memory}} as unknown as WebAssembly.Instance);
  const view = () => new DataView(memory.buffer);
  let free = 1024;
  const put = (bytes: Uint8Array) => { const at = free; new Uint8Array(memory.buffer).set(bytes, at); free += bytes.length + 8 - (bytes.length % 8); return at; };
  const str = (s: string): [number, number] => { const b = encoder.encode(s); return [put(b), b.length]; };
  const out = () => put(new Uint8Array(64));
  const w = wasi.imports as unknown as Record<string, (...a: (number | bigint)[]) => number>;
  const u32 = (at: number) => view().getUint32(at, true);
  const u64 = (at: number) => view().getBigUint64(at, true);

  const open = (path: string, oflags = 0, opts: {write?: boolean; append?: boolean; follow?: boolean} = {}): number | {errno: number} => {
    const fd = out();
    const r = w.path_open(3, opts.follow === false ? 0 : 1, ...str(path), oflags, opts.write ? (1n << 6n) | 2n : 2n, 0n, opts.append ? 1 : 0, fd);
    return r ? {errno: r} : u32(fd);
  };
  const fdOf = (r: number | {errno: number}) => { assert.equal(typeof r, 'number', `opened: ${JSON.stringify(r)}`); return r as number; };
  const write = (fd: number, text: string) => {
    const [buf, len] = str(text);
    const iov = put(new Uint8Array(8));
    view().setUint32(iov, buf, true);
    view().setUint32(iov + 4, len, true);
    const n = out();
    assert.equal(w.fd_write(fd, iov, 1, n), E.SUCCESS);
    return u32(n);
  };
  const read = (fd: number, max = 4096) => {
    const buf = put(new Uint8Array(max));
    const iov = put(new Uint8Array(8));
    view().setUint32(iov, buf, true);
    view().setUint32(iov + 4, max, true);
    const n = out();
    assert.equal(w.fd_read(fd, iov, 1, n), E.SUCCESS);
    return decoder.decode(new Uint8Array(memory.buffer, buf, u32(n)));
  };
  const stat = (path: string, follow = true) => {
    const buf = out();
    const r = w.path_filestat_get(3, follow ? 1 : 0, ...str(path), buf);
    return r ? {errno: r} : {ino: u64(buf + 8), type: view().getUint8(buf + 16), size: Number(u64(buf + 32)), mtime: u64(buf + 48)};
  };
  // The names fd_readdir hands out, in buffers of `size` bytes, each read going on from the last whole entry.
  const list = (path: string, size = 4096) => {
    const fd = fdOf(open(path, 2));
    const names: string[] = [];
    let cookie = 0n;
    for (;;) {
      const buf = put(new Uint8Array(size));
      const used = out();
      assert.equal(w.fd_readdir(fd, buf, size, cookie, used), E.SUCCESS);
      const n = u32(used);
      let at = 0;
      while (at + 24 <= n) {
        const len = u32(buf + at + 16);
        if (at + 24 + len > n) break;
        cookie = u64(buf + at);
        names.push(decoder.decode(new Uint8Array(memory.buffer, buf + at + 24, len)));
        at += 24 + len;
      }
      if (n < size) break;
      assert.ok(at > 0, 'a buffer holds at least one entry');
    }
    w.fd_close(fd);
    return names.filter((n) => n !== '.' && n !== '..');
  };
  const call = (name: string, path: string) => w[name](3, ...str(path));
  const rename = (from: string, to: string) => w.path_rename(3, ...str(from), 3, ...str(to));
  return {fs, wasi, w, open, fdOf, write, read, stat, list, call, rename, str, out, u32, u64, put, printed, view};
}

test('a file is made, written, read back and refused when made exclusively again', () => {
  const h = host();
  assert.equal(h.call('path_create_directory', 'data'), E.SUCCESS);
  const fd = h.fdOf(h.open('data/a.txt', 1, {write: true}));
  assert.equal(h.write(fd, 'hello'), 5);
  const stat = h.out();
  assert.equal(h.w.fd_filestat_get(fd, stat), E.SUCCESS);
  assert.equal(h.u64(stat + 32), 5n);
  h.w.fd_close(fd);
  const r = h.fdOf(h.open('/data/a.txt'));
  assert.equal(h.read(r), 'hello');
  assert.equal(h.read(r), '');
  assert.deepEqual(h.open('data/a.txt', 1 | 4, {write: true}), {errno: E.EXIST});
  assert.deepEqual(h.open('data/b.txt'), {errno: E.NOENT});
  assert.deepEqual(h.open('data/a.txt/x'), {errno: E.NOTDIR});
  assert.deepEqual(h.open('data/a.txt', 2), {errno: E.NOTDIR});
  assert.deepEqual(h.open('data', 0, {write: true}), {errno: E.ISDIR});
  assert.deepEqual(h.open('data', 8), {errno: E.ISDIR});
  assert.deepEqual(h.open('data', 1), {errno: E.ISDIR});
  assert.equal(h.call('path_create_directory', 'data'), E.EXIST);
  assert.equal(h.call('path_create_directory', 'none/x'), E.NOENT);
  assert.equal(new TextDecoder().decode(h.fs.read('/data/a.txt')), 'hello');
});

test('O_TRUNC empties a file and append writes at its end', () => {
  const h = host();
  h.fs.write('/f', encoder.encode('0123456789'));
  const a = h.fdOf(h.open('f', 0, {write: true, append: true}));
  h.write(a, 'ab');
  assert.equal(decoder.decode(h.fs.read('/f')), '0123456789ab');
  const t = h.fdOf(h.open('f', 8, {write: true}));
  h.write(t, 'xy');
  assert.equal(decoder.decode(h.fs.read('/f')), 'xy');
  // A seek past the end leaves zeros behind what is written there.
  const at = h.out();
  assert.equal(h.w.fd_seek(t, 4n, 0, at), E.SUCCESS);
  h.write(t, 'z');
  assert.deepEqual([...h.fs.read('/f')!], [120, 121, 0, 0, 122]);
  assert.equal(h.w.fd_tell(t, at), E.SUCCESS);
  assert.equal(h.u64(at), 5n);
});

test('a directory lists every name across buffers too small for all of them, by cookie', () => {
  const h = host();
  h.call('path_create_directory', 'd');
  const names = Array.from({length: 40}, (_, i) => `file-${String(i).padStart(2, '0')}-${'x'.repeat(i % 7)}`);
  for (const n of names) h.fs.write(`/d/${n}`, encoder.encode(n));
  h.call('path_create_directory', 'd/sub');
  assert.deepEqual(h.list('d').sort(), [...names, 'sub'].sort());
  assert.deepEqual(h.list('d', 64).sort(), [...names, 'sub'].sort());
  // The layout: d_next, d_ino, d_namlen, d_type, then the name at 24.
  const fd = h.fdOf(h.open('d', 2));
  const buf = h.put(new Uint8Array(256));
  const used = h.out();
  h.w.fd_readdir(fd, buf, 256, 0n, used);
  assert.equal(h.u64(buf), 1n);
  assert.equal(h.u32(buf + 16), 1);
  assert.equal(h.view().getUint8(buf + 20), 3);
  assert.equal(decoder.decode(new Uint8Array(h.wasi.memory!.buffer, buf + 24, 1)), '.');
  assert.deepEqual(h.open('d/file-00-', 2), {errno: E.NOTDIR});
  assert.equal(h.u32(used), 256);
});

test('rename replaces a file and an empty directory, never one that holds something', () => {
  const h = host();
  h.fs.write('/a', encoder.encode('new'));
  h.fs.write('/b', encoder.encode('old'));
  assert.equal(h.rename('a', 'b'), E.SUCCESS);
  assert.equal(decoder.decode(h.fs.read('/b')), 'new');
  assert.deepEqual(h.stat('a'), {errno: E.NOENT});
  h.call('path_create_directory', 'x');
  h.fs.write('/x/in', encoder.encode('1'));
  h.call('path_create_directory', 'empty');
  h.call('path_create_directory', 'full');
  h.fs.write('/full/f', encoder.encode('2'));
  assert.equal(h.rename('x', 'full'), E.NOTEMPTY);
  assert.equal(h.rename('b', 'empty'), E.ISDIR);
  assert.equal(h.rename('x', 'b'), E.NOTDIR);
  assert.equal(h.rename('x', 'x/inside'), E.INVAL);
  assert.equal(h.rename('missing', 'y'), E.NOENT);
  assert.equal(h.rename('x', 'empty'), E.SUCCESS);
  assert.equal(decoder.decode(h.fs.read('/empty/in')), '1');
  assert.deepEqual(h.stat('x'), {errno: E.NOENT});
});

test('remove and unlink say what is in the way', () => {
  const h = host();
  h.call('path_create_directory', 'd');
  h.fs.write('/d/f', encoder.encode('1'));
  assert.equal(h.call('path_remove_directory', 'd'), E.NOTEMPTY);
  assert.equal(h.call('path_remove_directory', 'd/f'), E.NOTDIR);
  assert.equal(h.call('path_unlink_file', 'd'), E.ISDIR);
  assert.equal(h.call('path_unlink_file', 'd/f'), E.SUCCESS);
  assert.equal(h.call('path_unlink_file', 'd/f'), E.NOENT);
  assert.equal(h.call('path_remove_directory', 'd'), E.SUCCESS);
  assert.equal(h.call('path_remove_directory', 'd'), E.NOENT);
});

test('a link is stat-ed as itself or as what it names, and read back', () => {
  const h = host();
  h.fs.write('/target', encoder.encode('12345'));
  assert.equal(h.w.path_symlink(...h.str('target'), 3, ...h.str('link')), E.SUCCESS);
  assert.equal(h.w.path_symlink(...h.str('target'), 3, ...h.str('link')), E.EXIST);
  const followed = h.stat('link');
  const itself = h.stat('link', false);
  assert.ok(!('errno' in followed) && !('errno' in itself));
  assert.equal(followed.type, 4);
  assert.equal(followed.size, 5);
  assert.equal(itself.type, 7);
  const buf = h.out();
  const used = h.out();
  assert.equal(h.w.path_readlink(3, ...h.str('link'), buf, 64, used), E.SUCCESS);
  assert.equal(decoder.decode(new Uint8Array(h.wasi.memory!.buffer, buf, h.u32(used))), 'target');
  assert.equal(h.w.path_readlink(3, ...h.str('target'), buf, 64, used), E.INVAL);
  assert.equal(h.read(h.fdOf(h.open('link'))), '12345');
  assert.deepEqual(h.open('link', 0, {follow: false}), {errno: E.LOOP});
  h.w.path_symlink(...h.str('loop'), 3, ...h.str('loop'));
  assert.deepEqual(h.stat('loop'), {errno: E.LOOP});
});

test('the preopen, the environment, the clocks and the output are as a module expects', () => {
  const h = host(new MemoryFS(), {LENGTH3_HOME: '/data', LANG: 'ja'});
  const p = h.out();
  assert.equal(h.w.fd_prestat_get(3, p), E.SUCCESS);
  assert.equal(h.u32(p + 4), 1);
  assert.equal(h.w.fd_prestat_get(4, p), E.BADF);
  const count = h.out();
  const size = h.out();
  h.w.environ_sizes_get(count, size);
  assert.equal(h.u32(count), 2);
  assert.equal(h.u32(size), 'LENGTH3_HOME=/data\0LANG=ja\0'.length);
  h.w.clock_time_get(0, 0n, p);
  assert.ok(Math.abs(Number(h.u64(p) / 1_000_000n) - Date.now()) < 5000);
  assert.equal(h.w.clock_time_get(9, 0n, p), E.INVAL);
  h.write(1, 'one\ntw');
  h.write(1, 'o\n');
  assert.deepEqual(h.printed, [[1, 'one'], [1, 'two']]);
  assert.throws(() => h.w.proc_exit(3), (e: unknown) => e instanceof Exit && e.code === 3);
  // A sleep of 20ms (a clock subscription) is waited out.
  const sub = h.put(new Uint8Array(48));
  h.view().setBigUint64(sub, 7n, true);
  h.view().setUint32(sub + 16, 1, true);
  h.view().setBigUint64(sub + 24, 20_000_000n, true);
  const ev = h.put(new Uint8Array(32));
  const n = h.out();
  const t0 = performance.now();
  assert.equal(h.w.poll_oneoff(sub, ev, 1, n), E.SUCCESS);
  assert.ok(performance.now() - t0 >= 15);
  assert.equal(h.u32(n), 1);
  assert.equal(h.u64(ev), 7n);
});

test('what changed is said by path, once; a snapshot restores everything', () => {
  const h = host();
  h.fs.write('/data/home/a', encoder.encode('1'));
  h.fs.write('/data/home/b', encoder.encode('2'));
  const first = h.fs.flush();
  assert.deepEqual(first.put.map((e) => e.path), ['/data', '/data/home', '/data/home/a', '/data/home/b']);
  assert.deepEqual(h.fs.flush(), {put: [], removed: []});
  assert.equal(h.fs.dirty, false);
  // Written aside and renamed over, as the core replaces a file: the new bytes at the name, the aside gone.
  const fd = h.fdOf(h.open('data/home/.a.tmp', 1 | 4, {write: true}));
  h.write(fd, '3');
  h.w.fd_close(fd);
  h.rename('data/home/.a.tmp', 'data/home/a');
  h.call('path_unlink_file', 'data/home/b');
  const next = h.fs.flush();
  assert.deepEqual(next.put.map((e) => e.path).sort(), ['/data/home', '/data/home/a']);
  assert.equal(decoder.decode(next.put.find((e) => e.path === '/data/home/a')!.data), '3');
  assert.deepEqual(next.removed.sort(), ['/data/home/.a.tmp', '/data/home/b']);
  // A directory moved: everything under it is under its new path, and gone from the old.
  h.fs.write('/data/x/y/z', encoder.encode('4'));
  h.fs.flush();
  h.rename('data/x', 'data/w');
  const moved = h.fs.flush();
  assert.deepEqual(moved.removed.sort(), ['/data/x', '/data/x/y', '/data/x/y/z']);
  assert.ok(['/data/w', '/data/w/y', '/data/w/y/z'].every((p) => moved.put.some((e) => e.path === p)));

  const other = new MemoryFS();
  other.restore(h.fs.snapshot());
  assert.equal(other.dirty, false);
  assert.deepEqual(other.snapshot(), h.fs.snapshot());
  assert.equal(decoder.decode(other.read('/data/w/y/z')), '4');
});

// ---- the core itself, as the browser runs it ----

const wasm = (() => {
  try { return buildCoreWasm({quiet: true}); } catch (e) {
    if (!hasCargo() && existsSync(coreWasmPath())) return coreWasmPath();
    if (!hasCargo()) return null;
    throw e;
  }
})();

test('the core runs over these files as the app runs it', {skip: wasm ? false : 'cargo is not installed, so the core (core/web) cannot be built'}, async () => {
  const fs = new MemoryFS();
  const wasi = new WASI({fs, env: {LENGTH3_HOME: '/data', LENGTH3_REMOTE: ''}, out: () => {}});
  const sent: string[] = [];
  const core = await Core.start(new WebAssembly.Module(readFileSync(wasm!)), wasi, (head) => {
    sent.push(head.url);
    return {status: 0, body: encoder.encode('offline')};
  });
  const ok = (name: string, args: unknown) => {
    const a = core.call(name, args);
    assert.ok('ok' in a, `${name}: ${JSON.stringify(a)}`);
    return a.ok as never;
  };
  assert.deepEqual(ok('repo_list', {}), []);
  assert.equal((ok('repo_create', {name: 'notes', template: 'empty'}) as {name: string}).name, 'notes');
  ok('repo_add', {repo: 'notes', dir: '', name: 'a.md', text: 'hello'});
  assert.deepEqual(ok('repo_read', {repo: 'notes', path: 'a.md'}), {size: 5, text: 'hello', truncated: false});
  assert.deepEqual((ok('repo_list', {}) as {name: string}[]).map((r) => r.name), ['notes']);
  assert.equal(ok('state_set', {key: 'profile', json: '{}'}), null);
  assert.equal(ok('state_get', {key: 'profile'}), '{}');
  const changes = ok('history_changes', {repo: 'notes'}) as {folders: {files: {path: string; status: string}[]}[]};
  assert.ok(changes.folders.flatMap((f) => f.files).some((f) => f.path === 'a.md' && f.status === 'added'));
  assert.deepEqual(core.call('no_such_command', {}), {error: 'There is no command no_such_command'});

  // What it wrote is in the files, and in what a host keeps.
  assert.equal(decoder.decode(fs.read('/data/repos/notes/a.md')), 'hello');
  const kept = fs.flush().put.map((e) => e.path);
  assert.ok(kept.includes('/data/repos/notes/a.md') && kept.includes('/data/home/profile.json'), kept.join(', '));

  // Another instance over the same files (a reload, or a tab) finds them as they were.
  const again = await Core.start(new WebAssembly.Module(readFileSync(wasm!)), new WASI({fs, env: {LENGTH3_HOME: '/data'}}), () => ({status: 0, body: new Uint8Array()}));
  assert.deepEqual(again.call('repo_read', {repo: 'notes', path: 'a.md'}), {ok: {size: 5, text: 'hello', truncated: false}});
  assert.deepEqual(sent, []);
});

test('a trap in the core is thrown to its host (the worker answers it as an error and starts afresh)', async () => {
  // memory, l3_alloc (0), l3_call (unreachable: what a panic comes to) and l3_free, by hand.
  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x11, 0x03, 0x60, 0x01, 0x7f, 0x01, 0x7f, 0x60, 0x02, 0x7f, 0x7f, 0x01, 0x7e, 0x60, 0x02, 0x7f, 0x7f, 0x00,
    0x03, 0x04, 0x03, 0x00, 0x01, 0x02,
    0x05, 0x03, 0x01, 0x00, 0x01,
    0x07, 0x29, 0x04,
    0x06, ...encoder.encode('memory'), 0x02, 0x00,
    0x08, ...encoder.encode('l3_alloc'), 0x00, 0x00,
    0x07, ...encoder.encode('l3_call'), 0x00, 0x01,
    0x07, ...encoder.encode('l3_free'), 0x00, 0x02,
    0x0a, 0x0d, 0x03, 0x04, 0x00, 0x41, 0x00, 0x0b, 0x03, 0x00, 0x00, 0x0b, 0x02, 0x00, 0x0b,
  ]);
  const core = await Core.start(new WebAssembly.Module(bytes), new WASI({fs: new MemoryFS()}), () => ({status: 0, body: new Uint8Array()}));
  assert.throws(() => core.call('repo_list', {}), WebAssembly.RuntimeError);
});
