import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {captureExecutableSource} from '../../runtime/linux/executable-source.ts';
import {ExecutableMappingModel, type ExecutableFileProof, type ExecutableMapTicket,
  type FileRxRequest, type MappedCodeObservation} from '../../runtime/linux/executable-mappings.ts';
import {FdTable} from '../../runtime/linux/fd.ts';
import {MNT, Mount, Vfs, mountTarget} from '../../runtime/linux/fs.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';

const PAGE = 4096, BASE = 0x10000, AT = BASE + 3 * PAGE, TEXT = 0x1020, VOFF = 0x3020;
const TEXT_END = 0x1170, TEXT_LEN = TEXT_END - TEXT, PATH = '/lib/libprobe.so.1', ORIGIN = 'root/index/libprobe';
const rx = {flags:0x812, prot:5, address:AT, fileOffset:PAGE, length:PAGE};
const code = new TextEncoder();
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const int = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** Byte-layout fixture only: never execute any bytes in these tests. */
function elf({length = TEXT_LEN, pie = true, seed = 0, dynamic = false} = {}) {
  const b = new Uint8Array(4 * PAGE), v = int(b);
  b.set([0x7f,69,76,70,2,1,1]);
  const bias = pie ? 0 : BASE;
  v.setUint16(16, pie ? 3 : 2, true); v.setUint16(18, 62, true); v.setUint32(20, 1, true);
  v.setBigUint64(24, BigInt(bias + VOFF), true); v.setBigUint64(32, 64n, true);
  v.setUint16(52, 64, true); v.setUint16(54, 56, true); v.setUint16(56, dynamic ? 4 : 3, true);
  const ph = (i: number, typ: number, flags: number, off: number, va: number, len: number, mem: number, align = PAGE) => {
    const at = 64 + i * 56;
    v.setUint32(at, typ, true); v.setUint32(at + 4, flags, true);
    for (const [j, n] of [off, va + bias, va + bias, len, mem, align].entries())
      v.setBigUint64(at + 8 + 8 * j, BigInt(n), true);
  };
  ph(0, 1, 4, 0, 0, 0x240, 0x240);
  ph(1, 1, 5, TEXT, VOFF, length, length + 64);
  ph(2, 1, 6, 0x3000, 0x6000, PAGE, PAGE);
  if (dynamic) ph(3, 2, 6, 0x3040, 0x6040, 32, 32, 8);
  for (let j = 0; j < length; ++j) b[TEXT + j] = (19 + 23 * j + seed) & 255;
  return b;
}

const setup = (bytes = elf(), read?: () => Uint8Array) => {
  const vfs = new Vfs(), file = mountTarget(vfs).file(PATH, 0o644, bytes.length, read ?? (() => bytes.slice()), ORIGIN);
  const capture = () => captureExecutableSource(vfs, PATH, {origin:ORIGIN, size:bytes.length});
  const k = new Kernel({vfs, console:{write() {}, read:() => new Uint8Array()}});
  const p = new Process(k, null);
  const memory = Object.assign(new WebAssembly.Memory({initial:8}), {users:1, written:[], keeps:false, imageOf:null});
  p.memory = memory; p.fixed = []; p.free = [];
  p.mapBase = 4 * 65536; p.mapEnd = p.mapBase; p.stackLow = 0; p.stackTop = p.mapBase;
  const call = (nr: number, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0) =>
    p.syscall(BigInt(nr), BigInt(a), BigInt(b), BigInt(c), BigInt(d), BigInt(e), BigInt(f));
  const open = (name = PATH, flags = 0) => {
    p.bytes.set(code.encode(name + '\0'), 1024);
    const fd = Number(call(2, 1024, flags)); assert(fd >= 0); return fd;
  };
  const m = new ExecutableMappingModel(vfs, memory, p.fds);
  const put = (fd: number, req: FileRxRequest = rx) =>
    Number(call(9, req.address, req.length, req.prot, req.flags, fd, req.fileOffset));
  const proof = async () => { const f = await m.authenticate(capture(), hash(bytes)); assert(f); return f; };
  return {m, p, k, vfs, memory, file, bytes, capture, proof, open, put, call};
};
type Setup = ReturnType<typeof setup>;
function map(r: Setup, f: ExecutableFileProof, fd: number, req: FileRxRequest = rx) {
  const stage = r.m.stage(f, fd, req); assert(stage);
  const start = r.put(fd, req); assert(start >= BASE);
  assert(r.m.recordMapped(stage, start));
  return start;
}

test('real stock mmap and canonical RX mapping identify bytes and both relative coordinate systems', async () => {
  const r = setup(), fd = r.open(), f = await r.proof();
  assert.equal(r.m.inspect(AT + 32), null);
  const start = map(r, f, fd);
  const o = r.m.inspect(start + 32, 15); assert(o);
  assert.deepEqual(o, {address:AT + 32, length:15, epoch:1n, fileSha256:hash(r.bytes), fileOffset:TEXT, objectOffset:VOFF, loadBias:BASE});
  assert(Object.isFrozen(o)); assert(r.m.confirm(o));
  assert.equal(r.m.inspect(AT), null, 'part of the file page preceding p_vaddr is not code');
  assert.equal(r.m.inspect(AT + 32 + TEXT_LEN - 1, 2), null, 'no inspection straddles end of backed RX');
  assert(r.m.inspect(AT + 32 + TEXT_LEN - 1, 1));
  assert.equal(r.m.inspect(AT + 32 + TEXT_LEN, 1), null, 'BSS and padding are not ELF code');
  assert.equal(r.call(3, fd), 0n);
  assert(r.m.confirm(o), 'an already-recorded mapping does not depend on the fd staying open');
});

test('non-FIXED kernel-selected location and page-aligned partial range yield their actual bias', async () => {
  const r = setup(elf({length:PAGE + 160})), fd = r.open(), f = await r.proof();
  const req = {...rx, address:0, fileOffset:2 * PAGE, flags:2}, start = map(r, f, fd, req);
  const o = r.m.inspect(start, 3);
  assert(o); assert.equal(o.fileOffset, 2 * PAGE); assert.equal(o.objectOffset, 4 * PAGE);
  assert.equal(o.loadBias, start - 4 * PAGE); assert(r.m.confirm(o));
});

test('same code cert at a different legal PIE placement and exact ET_EXEC base, not relocated ET_EXEC', async () => {
  const r = setup(), fd = r.open(), f = await r.proof();
  const a = map(r, f, fd), b = map(r, f, fd, {...rx, address:AT + 8 * PAGE});
  const x = r.m.inspect(a + 32)!, y = r.m.inspect(b + 32)!;
  assert(x && y && x.epoch !== y.epoch && x.loadBias !== y.loadBias);
  assert.equal(x.fileOffset, y.fileOffset); assert.equal(x.fileSha256, y.fileSha256);
  const fixed = setup(elf({pie:false})), xfd = fixed.open(), xf = await fixed.proof();
  assert.equal(fixed.m.inspect(map(fixed, xf, xfd) + 32)?.loadBias, 0);
  const req = {...rx, address:AT + 8 * PAGE}, stage = fixed.m.stage(xf, xfd, req); assert(stage);
  assert.equal(fixed.m.recordMapped(stage, fixed.put(xfd, req)), false);
});

test('permissions, flags, overflow, bad file slices, and unbounded instruction observations are denied', async () => {
  const r = setup(), fd = r.open(), f = await r.proof();
  for (const bad of [
    {prot:0}, {prot:3}, {prot:4}, {prot:7}, {prot:-1},
    {flags:1}, {flags:0x32}, {flags:0x42}, {flags:2 ** 32 + 2}, {flags:1.1},
    {address:4096}, {address:AT + 1}, {address:2 ** 32}, {address:NaN},
    {length:0}, {length:PAGE + 1}, {length:2 ** 32}, {length:Infinity},
    {fileOffset:0}, {fileOffset:PAGE + 1}, {fileOffset:3 * PAGE}, {fileOffset:2 ** 32 - PAGE},
  ]) assert.equal(r.m.stage(f, fd, {...rx, ...bad}), null, JSON.stringify(bad));
  const start = map(r, f, fd);
  for (const at of [NaN, -1, 2 ** 32, 2 ** 53, Infinity, start + 0.5])
    assert.equal(r.m.inspect(at), null);
  for (const n of [NaN, -1, 0, 16, Infinity, 1.5]) assert.equal(r.m.inspect(start + 32, n), null);
  assert.throws(() => r.m.retireRange(start, 1), RangeError);
  assert(r.m.inspect(start + 32));
});

test('real FD access modes, noexec bind mount and absent/foreign descriptor are refused', async () => {
  const r = setup(), f = await r.proof();
  for (const flags of [1, 0x200000]) assert.equal(r.m.stage(f, r.open(PATH, flags), rx), null);
  assert.equal(r.m.stage(f, 999, rx), null);
  const mount = new Mount(r.vfs.mount.sb, r.vfs.dir('/lib'), MNT.NOEXEC);
  r.vfs.mkdirp('/blocked'); r.k.mount('/blocked', mount);
  const fd = r.open('/blocked/libprobe.so.1');
  assert.equal(r.m.stage(f, fd, rx), null);
  assert.equal(r.put(fd), -1);
  assert.equal(r.m.inspect(AT + 32), null);
});

test('same-length overlay does not inherit, canonical-inode hardlink does', async () => {
  const r = setup(), f = await r.proof();
  mountTarget(r.vfs).hardlink(r.file, '/lib/alias');
  const replacement = r.vfs.writeFile(PATH, r.bytes.slice(), 0o755);
  replacement.origin = ORIGIN;
  assert.equal(r.m.stage(f, r.open(), rx), null);
  const at = map(r, f, r.open('/lib/alias'));
  assert(r.m.inspect(at + 32));
});

test('canonical-content hash precedes admission, and tokens cannot be copied or used in another model', async () => {
  const r = setup(), f = await r.proof(), fd = r.open();
  assert.equal(await r.m.authenticate(r.capture(), '0'.repeat(64)), null);
  assert.equal(await r.m.authenticate(r.capture(), 'not-a-digest'), null);
  await assert.rejects(r.m.authenticate(setup().capture(), hash(r.bytes)), /another Vfs/);
  const m2 = new ExecutableMappingModel(r.vfs, r.memory, r.p.fds);
  assert.equal(m2.stage(f, fd, rx), null);
  assert.equal(r.m.stage(structuredClone(f), fd, rx), null);
  const t = r.m.stage(f, fd, rx); assert(t);
  assert.equal(r.m.recordMapped(structuredClone(t), AT), false);
  assert.equal(r.m.recordMapped({} as ExecutableMapTicket, AT), false);
  assert(r.m.recordMapped(t, r.put(fd)));
  const o = r.m.inspect(AT + 32)!; assert(o);
  assert.equal(r.m.confirm({...o} as MappedCodeObservation), false);
  assert.equal(m2.confirm(o), false);
});

test('FD-slot ABA, execute flags changing between stages, or ticket replay cannot publish', async () => {
  const r = setup(), f = await r.proof(), fd = r.open();
  const stage = r.m.stage(f, fd, rx); assert(stage);
  const d = r.p.fds.get(fd)!;
  r.p.fds.install(d, {fd:23}); // same retained open description, different live descriptor slot
  r.p.fds.close(fd); r.p.fds.install(d, {fd});
  assert.equal(r.m.recordMapped(stage, r.put(fd)), false);
  assert.equal(r.m.recordMapped(stage, AT), false);
  const before = r.m.stage(f, fd, rx); assert(before);
  const start = r.put(fd); d.mnt!.flags |= MNT.NOEXEC;
  assert.equal(r.m.recordMapped(before, start), false); assert.equal(r.m.inspect(start + 32), null);
  d.mnt!.flags &= ~MNT.NOEXEC;
  assert.equal(r.m.recordMapped(before, start), false);
});

test('mmap result must be in the live memory at the correct fixed address and the mapped content must match', async () => {
  const r = setup(), f = await r.proof(), fd = r.open();
  for (const bad of [-1, Infinity, AT + 1, AT + PAGE, 2 ** 32 - PAGE]) {
    const t = r.m.stage(f, fd, rx); assert(t);
    assert.equal(r.m.recordMapped(t, bad), false);
  }
  const t = r.m.stage(f, fd, rx); assert(t);
  assert.equal(r.m.recordMapped(t, AT), false, 'reserved or zero memory without source code does not pass');
  const u = r.m.stage(f, fd, rx); assert(u);
  r.put(fd); r.p.bytes[AT + 32] ^= 1;
  assert.equal(r.m.recordMapped(u, AT), false);
  assert.equal(r.m.inspect(AT + 32), null);
  r.p.bytes[AT + 32] ^= 1;
  assert.equal(r.m.recordMapped(u, AT), false, 'correcting bytes cannot revive a refused ticket');
});

test('overlap needs explicit prior retirement; an identical re-map does not revive old observations', async () => {
  const r = setup(), f = await r.proof(), fd = r.open(), start = map(r, f, fd);
  const first = r.m.inspect(start + 32)!; assert(first);
  assert.equal(r.m.retireRange(start - PAGE, PAGE), 0); assert(r.m.confirm(first));
  assert.equal(r.m.retireRange(start, PAGE), 1);
  assert.equal(r.call(11, start, PAGE), 0n);
  assert.equal(r.m.confirm(first), false);
  assert.equal(map(r, f, fd), start);
  const second = r.m.inspect(start + 32)!;
  assert(second && second.epoch > first.epoch && r.m.confirm(second));
  assert.equal(r.m.confirm(first), false, 'same bytes and address, different lifetime');
});

test('a successful unretired overlap is refused and cannot keep older claims even with identical bytes', async () => {
  const r = setup(), f = await r.proof(), fd = r.open(), at = map(r, f, fd);
  const old = r.m.inspect(at + 32)!; assert(old);
  const collision = r.m.stage(f, fd, rx); assert(collision);
  assert.equal(r.put(fd), at); // actual stock MAP_FIXED replacement; observe it, never authorize it.
  assert.equal(r.m.recordMapped(collision, at), false);
  assert.equal(r.m.confirm(old), false); assert.equal(r.m.inspect(at + 32), null);
});

test('page overlap retires an entire multi-page claim, unrelated page remains valid', async () => {
  const r = setup(elf({length:PAGE + 160})), f = await r.proof(), fd = r.open();
  const at = map(r, f, fd, {...rx, length:2 * PAGE});
  const other = map(r, f, fd, {...rx, address:AT + 8 * PAGE});
  const x = r.m.inspect(at + 32)!, y = r.m.inspect(at + PAGE + 32)!, z = r.m.inspect(other + 32)!;
  assert(x && y && z);
  assert.equal(r.m.retireRange(at + PAGE, PAGE), 1);
  assert.equal(r.m.confirm(x), false); assert.equal(r.m.confirm(y), false); assert(r.m.confirm(z));
});

test('a different trusted inode can replace a released interval without inheriting old epoch or bytes', async () => {
  const r = setup(), f = await r.proof(), fd = r.open(), at = map(r, f, fd);
  const a = r.m.inspect(at + 32)!; assert(a);
  const bytes = elf({seed:1}), name = '/lib/second';
  mountTarget(r.vfs).file(name, 0o644, bytes.length, () => bytes.slice(), 'second-origin');
  const g = await r.m.authenticate(captureExecutableSource(r.vfs, name, {origin:'second-origin', size:bytes.length}), hash(bytes));
  assert(g); const fd2 = r.open(name);
  r.m.retireRange(at, PAGE);
  assert.equal(map(r, g, fd2), at);
  const b = r.m.inspect(at + 32)!;
  assert(b && b.epoch > a.epoch && b.fileSha256 !== a.fileSha256 && r.m.confirm(b));
  assert.equal(r.m.confirm(a), false);
});

test('observed guest write, source revision or live shared alias makes affected positive evidence sticky-invalid', async () => {
  for (const cause of ['memory', 'source', 'alias']) {
    const r = setup(), f = await r.proof(), fd = r.open(), at = map(r, f, fd);
    const old = r.m.inspect(at + 32, 3)!; assert(old);
    const alias = {proc:{bytes:r.bytes.slice()}, start:0, length:r.bytes.length, off:0};
    if (cause === 'memory') r.p.bytes[at + 33] ^= 1;
    if (cause === 'source') r.file.write(TEXT, r.bytes.slice(TEXT, TEXT + 1)); // even same bytes: different revision
    if (cause === 'alias') r.file.map(alias);
    assert.equal(r.m.confirm(old), false, cause);
    if (cause === 'memory') r.p.bytes[at + 33] ^= 1;
    if (cause === 'alias') r.file.abandon(alias);
    assert.equal(r.m.confirm(old), false);
    assert.equal(r.m.inspect(at + 32), null);
  }
});

test('explicit mount retirement binds exact mount; observed noexec cannot revive on flag restore', async () => {
  const r = setup(), f = await r.proof(), fd = r.open(), at = map(r, f, fd);
  const mount = new Mount(r.vfs.mount.sb, r.vfs.dir('/lib'));
  r.vfs.mkdirp('/same'); r.k.mount('/same', mount);
  const bfd = r.open('/same/libprobe.so.1'), b = map(r, f, bfd, {...rx, address:AT + 8 * PAGE});
  const x = r.m.inspect(at + 32)!, y = r.m.inspect(b + 32)!; assert(x && y);
  assert.equal(r.m.retireMount(mount), 1); assert(!r.m.confirm(y)); assert(r.m.confirm(x));
  const firstMount = r.p.fds.get(fd)!.mnt!;
  firstMount.flags |= MNT.NOEXEC; assert(!r.m.confirm(x)); firstMount.flags &= ~MNT.NOEXEC;
  assert(!r.m.confirm(x));
});

test('pending decisions fail after unrelated mutation or retirement; clearing also invalidates in-flight hash verification', async () => {
  const r = setup(), f = await r.proof(), fd = r.open(), t = r.m.stage(f, fd, rx); assert(t);
  r.m.retireRange(AT + PAGE, PAGE);
  assert.equal(r.m.recordMapped(t, r.put(fd)), false);
  const at = map(r, f, fd), old = r.m.inspect(at + 32)!; assert(old);
  r.memory.grow(1); assert(r.m.confirm(old), 'memory identity survives ordinary buffer replacement by grow');
  const t2 = r.m.stage(f, fd, {...rx, address:AT + PAGE}); assert(t2);
  const next = r.m.authenticate(r.capture(), hash(r.bytes));
  r.m.clear();
  assert.equal(await next, null);
  assert.equal(r.m.stage(f, fd, rx), null);
  assert.equal(r.m.recordMapped(t2, AT + PAGE), false); assert.equal(r.m.confirm(old), false);
  assert.equal(r.m.inspect(at + 32), null);
  assert.throws(() => new ExecutableMappingModel(r.vfs, new WebAssembly.Memory({initial:1, maximum:1, shared:true}), new FdTable()), /inline/);
});

test('file revision changes during hash or an active shared alias cannot certify unobserved data', async () => {
  const r = setup(), p = r.m.authenticate(r.capture(), hash(r.bytes));
  r.file.write(TEXT, r.bytes.slice(TEXT, TEXT + 1));
  assert.equal(await p, null);
  const q = setup(), alias = {proc:{bytes:q.bytes.slice()}, start:0, length:q.bytes.length, off:0};
  q.file.map(alias);
  assert.equal(await q.m.authenticate(q.capture(), hash(q.bytes)), null);
  q.file.abandon(alias);
  assert(await q.proof());
});

test('malformed or unsupported ELF layouts are negative controls; stock loader/permissions stay untouched', async () => {
  const hdr = (i: number) => 64 + 56 * i;
  const mutations = [
    (v: DataView) => v.setUint16(18, 183, true), // other machine
    (v: DataView) => v.setUint16(54, 8, true),
    (v: DataView) => v.setUint16(56, 129, true),
    (v: DataView) => v.setBigUint64(32, 2n ** 63n, true),
    (v: DataView) => v.setUint32(hdr(1) + 4, 7, true), // W+X
    (v: DataView) => v.setBigUint64(hdr(1) + 40, 1n, true), // filesz > memsz
    (v: DataView) => v.setBigUint64(hdr(1) + 48, 3n, true), // alignment not a power of two
    (v: DataView) => v.setBigUint64(hdr(1) + 16, 0x21n, true), // incongruent
    (v: DataView) => v.setBigUint64(hdr(1) + 16, 0x20n, true), // overlaps header page
    (v: DataView) => v.setBigUint64(hdr(1) + 16, 2n ** 32n + 32n, true),
    (v: DataView) => v.setBigUint64(hdr(3) + 8, 0x2400n, true), // dynamic outside PT_LOAD
    (v: DataView) => v.setBigUint64(0x3040, 22n, true), // DT_TEXTREL
    (v: DataView) => { v.setBigUint64(0x3040, 30n, true); v.setBigUint64(0x3048, 4n, true); }, // DF_TEXTREL
    (v: DataView) => { v.setBigUint64(0x3040, 30n, true); v.setBigUint64(0x3050, 30n, true); }, // no DT_NULL
    (v: DataView) => { v.setUint32(hdr(3), 0x6474e551, true); v.setUint32(hdr(3) + 4, 7, true); }, // exec GNU_STACK
  ];
  const good = setup(elf({dynamic:true})); assert(await good.proof());
  for (const mutate of mutations) {
    const bytes = elf({dynamic:true}); mutate(int(bytes));
    const r = setup(bytes);
    assert.equal(await r.m.authenticate(r.capture(), hash(bytes)), null, mutate.toString());
  }
});
