import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {captureExecutableSource} from '../../runtime/linux/executable-source.ts';
import {Description, FdTable} from '../../runtime/linux/fd.ts';
import {Vfs, mountTarget} from '../../runtime/linux/fs.ts';
import {GuardedFault, GuardedInlineMemory, type GuardedOwner} from '../../runtime/linux/guarded-inline-memory.ts';

const P = 4096, A = 65536;
const R = 1, RW = 3, RX = 5;
const t = new TextEncoder();
const name = (s: string) => [s.length, ...t.encode(s)];
const sec = (code: number, bytes: number[]) => [code, bytes.length, ...bytes];
const I64 = 0x7e, I32 = 0x7f;
const func = (i: number, n: number) => { const bytes = [0, ...Array.from({length:n}, (_, k) => [0x20,k]).flat(), 0x10,i,0x0b]; return [bytes.length, ...bytes]; };
// Three defined Wasm functions with no memory at all: each lowers its
// scalar operation to the guarded host import. A raw Wasm load/store is
// neither present nor possible in this explicit fixture mode.
const probe = new WebAssembly.Module(Uint8Array.of(
  0,97,115,109,1,0,0,0,
  ...sec(1,[2,0x60,2,I64,I32,1,I64,0x60,3,I64,I32,I64,0]),
  ...sec(2,[3,...name('guard'),...name('read'),0,0,...name('guard'),...name('write'),0,1,...name('guard'),...name('fetch'),0,0]),
  ...sec(3,[3,0,1,0]),
  ...sec(7,[3,...name('read'),0,3,...name('write'),0,4,...name('fetch'),0,5]),
  ...sec(10,[3,...func(0,2),...func(1,3),...func(2,2)]),
));
interface Access {
  read(at: bigint, width: number): bigint;
  write(at: bigint, width: number, word: bigint): void;
  fetch(at: bigint, width: number): bigint;
}
const wasmAccess = (g: GuardedInlineMemory, o: GuardedOwner): Access => {
  const guard = {
    read:(p: bigint, n: number) => g.read(o, p, n),
    write:(p: bigint, n: number, x: bigint) => g.write(o, p, n, x),
    fetch:(p: bigint, n: number) => g.inspectCode(o, p, n),
  };
  return new WebAssembly.Instance(probe, {guard}).exports as unknown as Access;
};
const faults = (op: () => unknown, kind: GuardedFault['kind'], at: bigint) =>
  assert.throws(op, e => e instanceof GuardedFault && e.kind === kind && e.address === at);

function source({read}: {read?: (b: Uint8Array) => Uint8Array} = {}) {
  const bytes = new Uint8Array(2 * P), v = new DataView(bytes.buffer);
  bytes.set([0x7f,69,76,70,2,1,1]);
  v.setUint16(16, 3, true); v.setUint16(18, 62, true); v.setUint32(20, 1, true);
  v.setBigUint64(32, 64n, true); v.setUint16(52, 64, true); v.setUint16(54, 56, true); v.setUint16(56, 1, true);
  v.setUint32(64, 1, true); v.setUint32(68, 5, true);
  for (const [i,x] of [P,P,P,6,6,P].entries()) v.setBigUint64(72 + i * 8, BigInt(x), true);
  bytes.set([0xb8,37,0,0,0,0xc3], P); // benign comparison bytes; not executed by this test
  const vfs = new Vfs(), fds = new FdTable(), path = '/lib/object', origin = 'guarded-fixture/origin';
  const file = mountTarget(vfs).file(path, 0o444, bytes.length, () => read?.(bytes) ?? bytes.slice(), origin);
  const fd = fds.install(new Description('file', {node:file, mnt:vfs.mount}));
  const token = captureExecutableSource(vfs, path, {origin, size:bytes.length});
  const digest = createHash('sha256').update(bytes).digest('hex');
  return {vfs,fds,file,fd,token,digest,bytes};
}
const memory = (src = source()) => {
  const g = new GuardedInlineMemory(4), o = g.installOwner(src.vfs, src.fds);
  return {src, g, o, wasm:wasmAccess(g, o)};
};
const req = {address:A + P, length:P, fileOffset:P, prot:RX, flags:0x812};
const get = async (g: GuardedInlineMemory, o: GuardedOwner, s: ReturnType<typeof source>) => {
  const proof = await g.authenticate(o, s.token, s.digest); assert(proof); return proof;
};

test('actual Wasm scalar access traps for holes and PROT_NONE; no guest raw memory is imported or exported', () => {
  const {g,o,wasm} = memory(), start = BigInt(A);
  for (const it of [...WebAssembly.Module.imports(probe), ...WebAssembly.Module.exports(probe)])
    assert.equal(it.kind, 'function');
  faults(() => wasm.read(start, 1), 'unmapped', start);
  g.installData(o, A, P, 0);
  faults(() => wasm.read(start, 1), 'permission', start);
  faults(() => wasm.write(start, 4, 0n), 'permission', start);
  faults(() => wasm.fetch(start, 1), 'permission', start);
  assert(g.protect(o, A, P, R));
  assert.equal(wasm.read(start, 4), 0n);
});

test('Wasm read/write is little endian and cannot alias low or high guest addresses', () => {
  const {g,o,wasm} = memory(), start = BigInt(A) + 3n;
  const seed = Uint8Array.of(1,2,3,4);
  g.installData(o, A, P, RW, seed); seed.fill(0);
  assert.equal(wasm.read(BigInt(A), 4), 0x04030201n);
  wasm.write(start, 8, 0x07123456789abcden);
  assert.equal(wasm.read(start, 8), 0x07123456789abcden);
  assert.equal(wasm.read(start + 2n, 2), 0x789an);
  for (const at of [-1n, 1n, 2n ** 32n + start, 2n ** 63n - 1n])
    faults(() => wasm.read(at, 1), 'unmapped', at);
  for (const width of [0,9,255]) assert.throws(() => wasm.read(start, width), /bounded scalar/);
});

test('split-page scalar store checks both pages before changing the writable prefix', () => {
  const {g,o,wasm} = memory(), edge = BigInt(A + P), start = edge - 4n;
  g.installData(o, A, 2 * P, RW);
  wasm.write(start, 8, 0x12345678cafebaben);
  assert.equal(wasm.read(start, 8), 0x12345678cafebaben);
  assert(g.protect(o, A + P, P, R));
  faults(() => wasm.write(start, 8, 0n), 'permission', edge);
  assert.equal(wasm.read(start, 8), 0x12345678cafebaben);
  g.unmap(o, A + P, P);
  faults(() => wasm.read(start, 8), 'unmapped', edge);
  assert.equal(wasm.read(start, 4), 0xcafebaben);
});

test('protect validation across a hole is transactional and stage never grants anonymous X', () => {
  const {g,o,wasm} = memory(), start = BigInt(A);
  g.installData(o, A, P, RW);
  assert.equal(g.protect(o, A, 2 * P, R), false);
  wasm.write(start, 1, 9n); assert.equal(wasm.read(start, 1), 9n);
  assert.equal(g.protect(o, A, P, 7), false);
  assert.equal(g.protect(o, A, P, RX), false);
  assert.throws(() => g.installData(o, A + P, P, RX), /anonymous/);
  assert.equal(g.protect(o, A, P, R), true);
  faults(() => wasm.write(start, 1, 0n), 'permission', start); assert.equal(wasm.read(start, 1), 9n);
});

test('authenticated file RX admits fetch, not guest write, padding execution, or later writable/execute promotion', async () => {
  const {g,o,wasm,src} = memory(), proof = await get(g,o,src), at = BigInt(req.address);
  assert(g.installRx(o, proof, src.fd, req));
  assert.equal(wasm.fetch(at, 5), 0x25b8n);
  assert.equal(wasm.read(at, 4), 0x25b8n);
  faults(() => wasm.write(at, 1, 0n), 'permission', at);
  faults(() => wasm.fetch(at + 6n, 1), 'permission', at + 6n);
  assert(g.protect(o, req.address, P, RX)); // no change preserves the proof
  assert.equal(wasm.fetch(at + 5n, 1), 0xc3n);
  assert(g.protect(o, req.address, P, R));
  faults(() => wasm.fetch(at, 1), 'permission', at);
  assert.equal(g.protect(o, req.address, P, RW), false);
  assert.equal(g.protect(o, req.address, P, RX), false);
  assert.equal(wasm.read(at, 4), 0x25b8n);
});

test('drop and re-install at same VA clears old execute claim and old data before exposing next page', async () => {
  const {g,o,wasm,src} = memory(), proof = await get(g,o,src), at = BigInt(req.address);
  assert(g.installRx(o, proof, src.fd, req));
  assert.throws(() => g.installData(o, req.address, P, RW), /occupied/);
  g.unmap(o, req.address, P);
  faults(() => wasm.fetch(at, 1), 'unmapped', at);
  g.installData(o, req.address, P, RW);
  assert.equal(wasm.read(at, 4), 0n);
  faults(() => wasm.fetch(at, 1), 'permission', at);
  wasm.write(at, 4, 32n);
  assert.equal(g.installRx(o, proof, src.fd, req), false, 'failed fresh-only RX does not overwrite live data');
  assert.equal(wasm.read(at, 4), 32n);
  g.unmap(o, req.address, P);
  assert(g.installRx(o, proof, src.fd, req));
  g.installData(o, req.address, P, R, Uint8Array.of(5), true);
  assert.equal(wasm.read(at, 4), 5n);
  faults(() => wasm.fetch(at, 1), 'permission', at);
});

test('stale source or closed fd drops first-profile code admission without giving out write rights', async () => {
  const {g,o,wasm,src} = memory(), proof = await get(g,o,src), at = BigInt(req.address);
  assert(g.installRx(o, proof, src.fd, req));
  src.file.write(P, src.bytes.slice(P, P + 1));
  faults(() => wasm.fetch(at, 1), 'permission', at);
  faults(() => wasm.write(at, 1, 0n), 'permission', at);
  assert.equal(wasm.read(at, 4), 0x25b8n); // private old bytes remain readable
  g.unmap(o, req.address, P);
  assert.equal(g.installRx(o, proof, src.fd, req), false);
  const r = memory(), f = await get(r.g,r.o,r.src);
  r.src.fds.close(r.src.fd);
  assert.equal(r.g.installRx(r.o, f, r.src.fd, req), false);
  faults(() => r.wasm.read(at, 1), 'unmapped', at);
});

test('new owner installation revokes old Wasm closures before reuse and refuses pending authentication', async () => {
  const {g,o,wasm,src} = memory(), at = BigInt(A);
  g.installData(o, A, P, RW, Uint8Array.of(85));
  assert.equal(wasm.read(at, 1), 85n);
  const pending = g.authenticate(o, src.token, src.digest);
  const nsrc = source(), next = g.installOwner(nsrc.vfs, nsrc.fds), now = wasmAccess(g,next);
  faults(() => wasm.read(at, 1), 'owner', at);
  faults(() => wasm.write(at, 1, 0n), 'owner', at);
  assert.equal(await pending, null);
  faults(() => now.read(at, 1), 'unmapped', at);
  g.installData(next, A, P, RW);
  assert.equal(now.read(at, 1), 0n);
  assert.throws(() => g.installOwner({} as Vfs, new FdTable()), /one inline guest/);
  assert.equal(now.read(at, 1), 0n); // failed preparation leaves this owner intact
  g.retireOwner(next);
  faults(() => now.read(at, 1), 'owner', at);
});

test('trusted lazy source reentry installs a new owner without publishing old bytes', async () => {
  let replace: (() => void) | undefined;
  const s = source({read:b => {replace?.(); return b.slice();}});
  const {g,o} = memory(s), f = await get(g,o,s);
  assert(s.file.release() > 0);
  const n = source();
  let fresh: GuardedOwner | undefined;
  replace = () => { fresh = g.installOwner(n.vfs,n.fds); };
  assert.equal(g.installRx(o, f, s.fd, req), false);
  assert(fresh);
  faults(() => wasmAccess(g,o).fetch(BigInt(req.address),1), 'owner', BigInt(req.address));
  faults(() => wasmAccess(g,fresh!).read(BigInt(req.address),1), 'unmapped', BigInt(req.address));
});
