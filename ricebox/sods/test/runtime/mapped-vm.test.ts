import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {MappedCodeChanged} from '../../runtime/linux/exec/mapped-code-space.ts';
import {MAPPED_ABI_VERSION} from '../../runtime/linux/exec/mapped-code-table.ts';
import {MappedDataFault, MappedDispatcher} from '../../runtime/linux/exec/mapped-dispatcher.ts';
import {Description} from '../../runtime/linux/fd.ts';
import type {ExecutableSource} from '../../runtime/linux/executable-source.ts';
import {Exit} from '../../runtime/linux/flow.ts';
import {E, File, FsError, MNT, mountTarget, Vfs} from '../../runtime/linux/fs.ts';
import {captureMappedLibraries} from '../../runtime/linux/mapped-libraries.ts';
import {MAPPED_COPY_LIMIT, MAPPED_STRING_LIMIT, MAPPED_VM_LIMIT, MappedStringLimit, MappedVm} from '../../runtime/linux/mapped-vm.ts';
import type {Kern} from '../../runtime/linux/parts.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {ReadLifetimeError} from '../../runtime/linux/read-lifetime.ts';
import {SHARES} from '../../runtime/linux/thread-abi.ts';
import {captureExecutableSource} from '../../runtime/linux.ts';
import {loadTranslator} from '../../runtime/translate.ts';
import type {ElfLoadSpec} from '../../runtime/translation/dynamic-load.ts';
import type {Translate} from '../../runtime/translation/translator.ts';
import {X87} from '../../runtime/translation/x87.ts';

const wasm = process.env.SODS_TEST_MAPPED_WASM;
const officialRoot = process.env.SODS_TEST_DYNAMIC_ROOT;
const skip = !wasm ? 'requires a translator built with mapped-code' : false;
const PAGE = 4096, BASE = 0x10000, NAME = 0x50000;
const err = (n: number) => BigInt(-n);
const consoleOut = {read: () => null, write() {}};
const neverDescribe = {describeDynamic() { assert.fail('no executable request'); }, notProgram: () => false};
const encode = new TextEncoder();
const syscall = (p: Process, n: number, ...args: number[]): bigint => p.syscall(BigInt(n),
  ...[...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]);

function fixture(vfs: Vfs, path: string, bytes: Uint8Array, loader = () => bytes, ownership?: 'owned') {
  const origin = createHash('sha256').update(bytes).digest('hex');
  const file = mountTarget(vfs).file(path, 0o644, bytes.length, loader, origin, ownership);
  return {file, source: captureExecutableSource(vfs, path, {origin, size: bytes.length})};
}

function processWithVm(vfs = new Vfs(), {base = BASE, sources = [], translate, initial, write = consoleOut.write}: {
  base?: number; sources?: ExecutableSource[]; translate?: Translate;
  initial?: Parameters<typeof MappedVm.allocate>[1]; write?(fd: number, bytes: Uint8Array): void;
} = {}) {
  const kernel = new Kernel({vfs, translate, console: {...consoleOut, write}}), p = new Process(kernel, null);
  p.mapBase = p.mapEnd = p.stackTop = base;
  p.stackLow = 4096;
  p.free = []; p.fixed = [];
  p.noNewPrivs = true;
  const reader = translate ? {describeDynamic: translate.describeDynamic!, notProgram: translate.notProgram} : neverDescribe;
  const libraries = sources.length ? captureMappedLibraries(vfs, sources) : undefined;
  const memory = p.memory = MappedVm.allocate({vfs, base, pages: Math.ceil(base / 65536), libraries, reader}, initial), vm = memory.mappedVm;
  assert.equal(syscall(p, 9, NAME, PAGE, 3, 0x32, -1, 0), BigInt(NAME));
  const user = () => vm.userMemory(p);
  const open = (path: string, flags = 0) => {
    user().copyOut(NAME, encode.encode(path + '\0'));
    const fd = Number(syscall(p, 2, NAME, flags));
    assert.ok(fd >= 0, 'open the Vfs inode through the standard syscall');
    return fd;
  };
  const clean = () => { if (p.state === 'live') kernel.exitProcess(p, 0); kernel.halt(); };
  return {kernel, p, memory, vm, code: vm.code, user, open, clean};
}

function staticPeer(kernel: Kernel): Process {
  const peer = new Process(kernel, null);
  peer.stackLow = PAGE;
  peer.stackTop = 2 * PAGE;
  peer.mapBase = peer.mapEnd = 65536;
  peer.free = [];
  peer.fixed = [];
  peer.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  return peer;
}

test('mapped VM is one inline owner, with bounded private mmap/mprotect/munmap and no static reuse', () => {
  const {kernel, p, memory, vm, user, clean} = processWithVm();
  try {
    const foreignKernel = new Kernel({console: consoleOut}), foreign = new Process(foreignKernel, null);
    try {
      foreign.noNewPrivs = true;
      assert.throws(() => { foreign.memory = memory; }, /another Vfs/);
    } finally { foreignKernel.exitProcess(foreign, 0); foreignKernel.halt(); }
    const other = new Process(kernel, null);
    try {
      other.noNewPrivs = true;
      assert.throws(() => { other.memory = memory; }, /owner/);
      assert.equal(other.memory, null);
    } finally { kernel.exitProcess(other, 0); }
    const epoch = vm.code.generation;
    assert.equal(syscall(p, 9, 0, PAGE + 1, 3, 0x22, -1, 0), BigInt(BASE));
    assert.equal(vm.code.generation, epoch, 'data-only publication does not discard code');
    assert.equal(syscall(p, 9, BASE, PAGE, 3, 0x100022, -1, 0), err(E.EXIST));
    assert.equal(syscall(p, 9, 0, PAGE, 5, 0x22, -1, 0), err(E.ACCES));
    assert.equal(syscall(p, 10, BASE, PAGE, 7), err(E.ACCES));
    assert.equal(syscall(p, 10, BASE, PAGE, 5), err(E.ACCES));
    assert.equal(syscall(p, 10, BASE, 3 * PAGE, 1), err(E.NOMEM), 'mprotect cannot pretend a hole is mapped');
    assert.equal(syscall(p, 9, BASE, PAGE, 3, 0x21, -1, 0), err(E.OPNOTSUPP));
    assert.equal(syscall(p, 25, BASE, PAGE, 2 * PAGE), err(E.NOSYS));
    assert.equal(syscall(p, 28, BASE, PAGE, 4), err(E.NOSYS));
    assert.throws(() => p.forkProcess(0n), e => e instanceof FsError && e.errno === E.OPNOTSUPP);
    assert.throws(() => p.newThread(0n, 0n, null), e => e instanceof FsError && e.errno === E.OPNOTSUPP);
    user().copyOut(BASE, Uint8Array.of(7)); user().copyOut(BASE + PAGE, Uint8Array.of(8));
    assert.equal(syscall(p, 10, BASE, PAGE, 1), 0n);
    assert.equal(syscall(p, 11, BASE, 1), 0n);
    assert.equal(new Uint8Array(memory.buffer, BASE, 1)[0], 0);
    assert.equal(user().copyIn(BASE + PAGE, 1)[0], 8);
    assert.equal(syscall(p, 9, 0, PAGE, 3, 0x22, -1, 0), BigInt(BASE), 'the released page can be reused');
  } finally { clean(); }
  assert.equal(memory.users, 0);
  assert.ok(!kernel.spareMemories.includes(memory));
});

test('batched memory growth keeps spare pages inaccessible and retries the required size', () => {
  const {p, memory, vm, user, clean} = processWithVm();
  try {
    const map = (at: number) => syscall(p, 9, at, PAGE, 3, 0x32, -1, 0);
    const first = memory.buffer.byteLength;
    assert.equal(map(first), BigInt(first));
    const backing = memory.buffer, spare = first + 65536;
    assert.ok(backing.byteLength > spare);
    assert.equal(vm.permits(BigInt(spare), 1n, 'read'), false);
    assert.equal(vm.permits(BigInt(spare), 1n, 'write'), false);
    assert.equal(map(spare), BigInt(spare));
    assert.equal(memory.buffer, backing);
    assert.deepEqual(user().copyIn(spare, 1), Uint8Array.of(0));

    const attempts: number[] = [], grow = memory.grow.bind(memory);
    memory.grow = pages => {
      attempts.push(pages);
      if (pages > 1) throw new RangeError('No spare capacity available');
      return grow(pages);
    };
    const next = backing.byteLength;
    assert.equal(map(next), BigInt(next));
    assert.equal(attempts.length, 2);
    assert.ok(attempts[0] > 1);
    assert.equal(attempts[1], 1);
    assert.equal(memory.buffer.byteLength, next + 65536);
  } finally { clean(); }
});

test('mapped stack reservations protect the guard and fixed replacement clears old bytes', () => {
  const {p, user, clean} = processWithVm();
  try {
    const stack = BASE + PAGE, top = stack + PAGE;
    assert.equal(syscall(p, 9, 0, 2 * PAGE, 0, 0x20022, -1, 0), BigInt(BASE));
    assert.equal(syscall(p, 10, stack, PAGE, 3), 0n);
    assert.equal(user().prefix(BASE, 1, 'read'), 0);
    user().copyOut(stack, Uint8Array.of(42));
    assert.equal(syscall(p, 9, top + PAGE, PAGE, 3, 0x32, -1, 0), BigInt(top + PAGE));
    user().copyOut(top + PAGE, Uint8Array.of(7));
    assert.equal(syscall(p, 9, stack, 2 * PAGE, 3, 0x32, -1, 0), BigInt(stack));
    assert.equal(user().copyIn(stack, 2 * PAGE).some(Boolean), false);
    assert.equal(user().copyIn(top + PAGE, 1)[0], 7);
    assert.equal(user().prefix(BASE, 1, 'read'), 0);
  } finally { clean(); }
});

test('mapped MAP_NORESERVE keeps the ordinary capacity and page permissions', () => {
  const {p, user, clean} = processWithVm();
  try {
    user().copyOut(NAME, encode.encode('arena\0'));
    const fd = Number(syscall(p, 319, NAME, 1));
    assert.ok(fd >= 0);
    assert.equal(syscall(p, 77, fd, 2 * PAGE), 0n);
    assert.equal(syscall(p, 9, 0, MAPPED_VM_LIMIT, 0, 0x4002, fd, 0), err(E.NOMEM));
    assert.equal(syscall(p, 9, 0, 2 * PAGE, 0, 0x4002, fd, 0), BigInt(BASE));
    assert.equal(user().prefix(BASE, 1, 'read'), 0);
    assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 3), 0n);
    user().copyOut(BASE + PAGE, Uint8Array.of(42));
    assert.equal(user().copyIn(BASE + PAGE, 1)[0], 42);
    assert.equal(user().prefix(BASE, 1, 'write'), 0);
  } finally { clean(); }
});

test('mapped memfd stores publish and rearm only the written pages', () => {
  const {p, code, memory, user, clean} = processWithVm();
  try {
    user().copyOut(NAME, encode.encode('wayland-shm\0'));
    const fd = Number(syscall(p, 319, NAME, 3)), file = p.fds.get(fd)?.node;
    const alias = BASE + 4 * PAGE, rights = new Uint8Array(code.accessPages.buffer);
    assert.ok(file instanceof File);
    assert.equal(syscall(p, 77, fd, 2 * PAGE + 3), 0n);
    const duplicate = Number(syscall(p, 72, fd, 1030, 10));
    assert.ok(duplicate >= 10 && p.fds.cloexec(duplicate));
    assert.equal(p.fds.get(duplicate)?.node, file);
    assert.equal(syscall(p, 9, BASE, 3 * PAGE, 3, 0x11, fd, 0), BigInt(BASE));
    assert.equal(syscall(p, 9, alias, 3 * PAGE, 1, 0x11, duplicate, 0), BigInt(alias));
    assert.deepEqual(rights.slice(BASE / PAGE, BASE / PAGE + 3), Uint8Array.of(1, 1, 1));
    assert.equal(code.beginWrite(BigInt(BASE + 2 * PAGE - 2), 4n), true);
    new Uint8Array(memory.buffer, BASE + 2 * PAGE - 2, 4).set([10, 20, 30, 40]);
    assert.deepEqual(rights.slice(BASE / PAGE, BASE / PAGE + 3), Uint8Array.of(1, 3, 3));
    assert.deepEqual(file.read(2 * PAGE, 2 * PAGE + 1), Uint8Array.of(30));
    assert.deepEqual(rights.slice(BASE / PAGE, BASE / PAGE + 3), Uint8Array.of(1, 3, 1));
    assert.deepEqual(user().copyIn(alias + 2 * PAGE, 2), Uint8Array.of(30, 40));
    assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 1), 0n);
    assert.equal(user().prefix(BASE + PAGE, 1, 'write'), 0);
    assert.deepEqual(user().copyIn(alias + 2 * PAGE - 2, 4), Uint8Array.of(10, 20, 30, 40));
    assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 3), 0n);
    assert.equal(syscall(p, 77, fd, 2 * PAGE), 0n);
    assert.equal(code.beginWrite(BigInt(BASE + 2 * PAGE - 2), 4n), false);
    assert.equal(rights[BASE / PAGE + 1], 1, 'reject the entire store before tracking any page');
    assert.equal(syscall(p, 77, fd, 2 * PAGE + 3), 0n);
    assert.deepEqual(user().copyIn(BASE + 2 * PAGE, 4), Uint8Array.of(0, 0, 0, 0));
    assert.equal(syscall(p, 3, fd), 0n);
    assert.equal(syscall(p, 3, duplicate), 0n);
    user().copyOut(BASE + 2 * PAGE, Uint8Array.of(44, 55, 66, 77));
    clean();
    assert.deepEqual(file.read(2 * PAGE, 3 * PAGE), Uint8Array.of(44, 55, 66));
    assert.equal(file.size, 2 * PAGE + 3);
    assert.equal(file.maps, null);
    assert.equal(file.hasSharedAliases, false);
  } finally { if (p.state === 'live') clean(); }
});

test('read-only shared mmap retains the file offset, page rights and lifetime', () => {
  const vfs = new Vfs(), bytes = new Uint8Array(2 * PAGE + 3);
  bytes[PAGE] = 10;
  bytes[2 * PAGE] = 20;
  const file = vfs.writeFile('/plugin.so', bytes);
  const {p, memory, code, user, open, clean} = processWithVm(vfs);
  const copy = BASE + 4 * PAGE;
  const mayRead = (at: number): number => new Uint8Array(code.accessPages.buffer)[at / PAGE];
  try {
    const source = open('/plugin.so'), writer = open('/plugin.so', 2);
    const map = (at: number) => syscall(p, 9, at, 3 * PAGE, 1, 0x11, source, PAGE);
    const write = (offset: number, value: number) => {
      user().copyOut(NAME, Uint8Array.of(value));
      assert.equal(syscall(p, 18, writer, NAME, 1, offset), 1n);
    };
    assert.equal(map(BASE), BigInt(BASE));
    assert.equal(map(copy), BigInt(copy));
    assert.equal(syscall(p, 9, BASE, PAGE, 1, 0x100001, source, 0), err(E.EXIST));
    assert.equal(syscall(p, 9, BASE, PAGE, 3, 0x11, writer, 0), err(E.OPNOTSUPP));
    assert.equal(syscall(p, 3, source), 0n);
    assert.equal(user().copyIn(BASE, 1)[0], 10);
    assert.deepEqual(user().copyIn(BASE + PAGE, 4), Uint8Array.of(20, 0, 0, 0));
    assert.equal(user().prefix(BASE, 3 * PAGE, 'read'), 2 * PAGE);
    assert.equal(user().prefix(BASE + 2 * PAGE + 1, 1, 'read'), 0);
    assert.equal(mayRead(BASE + 2 * PAGE), 0);
    assert.equal(syscall(p, 0, writer, BASE, 1), err(E.FAULT));
    assert.equal(syscall(p, 10, BASE, PAGE, 3), err(E.ACCES));
    assert.equal(syscall(p, 10, BASE, PAGE, 5), err(E.ACCES));

    // Force a new Wasm memory buffer after the mappings are installed.
    assert.equal(syscall(p, 9, NAME + 0x10000, PAGE, 3, 0x32, -1, 0), BigInt(NAME + 0x10000));
    assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 0), 0n);
    write(2 * PAGE, 21);
    assert.equal(mayRead(BASE + PAGE), 0);
    assert.equal(user().copyIn(copy + PAGE, 1)[0], 21);
    assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 1), 0n);
    assert.equal(user().copyIn(BASE + PAGE, 1)[0], 21);

    assert.equal(syscall(p, 11, BASE + PAGE, PAGE), 0n);
    assert.equal(syscall(p, 9, copy + PAGE, PAGE, 3, 0x32, -1, 0), BigInt(copy + PAGE));
    user().copyOut(copy + PAGE, Uint8Array.of(99));
    write(2 * PAGE, 22);
    write(3 * PAGE + 1, 31);
    assert.equal(user().prefix(BASE + PAGE, 1, 'read'), 0);
    assert.equal(user().copyIn(copy + PAGE, 1)[0], 99);
    assert.deepEqual(user().copyIn(BASE + 2 * PAGE, 3), Uint8Array.of(0, 31, 0));
    assert.deepEqual(user().copyIn(copy + 2 * PAGE, 3), Uint8Array.of(0, 31, 0));
    assert.equal(mayRead(BASE + 2 * PAGE), 1);
    assert.equal(syscall(p, 77, writer, PAGE + 5), 0n);
    assert.equal(mayRead(BASE + 2 * PAGE), 0);
    assert.equal(user().prefix(copy + 2 * PAGE, 1, 'read'), 0);
    write(3 * PAGE + 3, 32);
    assert.deepEqual(user().copyIn(BASE + 2 * PAGE, 4), Uint8Array.of(0, 0, 0, 32));
  } finally { clean(); }
  assert.equal(file.hasSharedAliases, false);
  assert.equal(memory.users, 0);
  const old = new Uint8Array(memory.buffer, BASE, 1)[0];
  file.write(PAGE, Uint8Array.of(42));
  assert.equal(new Uint8Array(memory.buffer, BASE, 1)[0], old);
});

test('a read-only alias observes stores made through the existing writable mapping path', () => {
  const vfs = new Vfs(), file = vfs.writeFile('/shared', Uint8Array.of(1));
  const {kernel, p, user, open, clean} = processWithVm(vfs);
  const writer = staticPeer(kernel), at = 0x2000;
  writer.bytes[at] = 1;
  try {
    writer.mapShared(file, at, PAGE, 0);
    assert.equal(writer.view.getInt32(SHARES, true), 0);
    const fd = open('/shared');
    assert.equal(syscall(p, 9, BASE, PAGE, 1, 1, fd, 0), BigInt(BASE));
    assert.equal(writer.view.getInt32(SHARES, true), 1);
    writer.bytes[at] = 42;
    writer.syncShared();
    assert.equal(user().copyIn(BASE, 1)[0], 42);
    assert.equal(syscall(p, 11, BASE, PAGE), 0n);
    assert.equal(writer.view.getInt32(SHARES, true), 0);
  } finally {
    try { kernel.exitProcess(writer, 0); }
    finally { clean(); }
  }
});

test('mapped Unix streams check guest addresses before sharing bytes and descriptors with a static peer', () => {
  const {kernel, p, user, open, clean} = processWithVm();
  const peer = staticPeer(kernel), at = 0x2000;
  const address = Uint8Array.of(1, 0, ...encode.encode('/wayland-0\0'));
  kernel.vfs.writeFile('/buffer', Uint8Array.of(42));
  const message = (base: number, fd?: number) => {
    const bytes = new Uint8Array(98), view = new DataView(bytes.buffer);
    view.setBigUint64(16, BigInt(base + 56), true); // one iovec
    view.setBigUint64(24, 1n, true);
    view.setBigUint64(32, BigInt(base + 72), true); // one aligned cmsghdr
    view.setBigUint64(40, 24n, true);
    view.setBigUint64(56, BigInt(base + 96), true);
    view.setBigUint64(64, 2n, true);
    if (fd !== undefined) {
      view.setBigUint64(72, 20n, true);
      view.setInt32(80, 1, true); // SOL_SOCKET
      view.setInt32(84, 1, true); // SCM_RIGHTS
      view.setInt32(88, fd, true);
      bytes.set([12, 34], 96);
    }
    return {bytes, view};
  };
  try {
    assert.equal(syscall(p, 41, 2, 1, 0), err(E.AFNOSUPPORT));
    const client = Number(syscall(p, 41, 1, 0x80001, 0));
    const listener = Number(syscall(peer, 41, 1, 0x80801, 0));
    assert.ok(client >= 0 && listener >= 0);
    assert.equal(p.fds.cloexec(client), true);
    peer.bytes.set(address, at);
    assert.equal(syscall(peer, 49, listener, at, address.length), 0n);
    assert.equal(syscall(peer, 50, listener, 1), 0n);

    const boundary = NAME + PAGE - 2;
    user().copyOut(boundary, address.subarray(0, 2));
    assert.equal(syscall(p, 42, client, boundary, address.length), err(E.FAULT));
    assert.equal(syscall(peer, 43, listener, 0, 0), err(E.AGAIN));
    user().copyOut(NAME, address);
    assert.equal(syscall(p, 42, client, NAME, address.length), 0n);
    const accepted = Number(syscall(peer, 288, listener, 0, 0, 0x800));
    assert.ok(accepted >= 0);

    const fd = open('/buffer'), held = p.fds.get(fd), slot = NAME + 128;
    const badSend = message(slot, fd);
    badSend.view.setBigUint64(56, BigInt(boundary + 1), true);
    user().copyOut(slot, badSend.bytes);
    assert.equal(syscall(p, 46, client, slot, 0), err(E.FAULT));
    peer.bytes.set(message(at).bytes, at);
    assert.equal(syscall(peer, 47, accepted, at, 0), err(E.AGAIN));
    user().copyOut(slot, message(slot, fd).bytes);
    assert.equal(syscall(p, 46, client, slot, 0), 2n);
    assert.equal(syscall(p, 3, fd), 0n);
    assert.equal(syscall(peer, 47, accepted, at, 0x40000000), 2n);
    assert.deepEqual(peer.bytes.slice(at + 96, at + 98), Uint8Array.of(12, 34));
    const received = peer.view.getInt32(at + 88, true);
    assert.equal(peer.fds.cloexec(received), true);
    assert.equal(peer.fds.get(received), held);

    peer.bytes.set(message(at, received).bytes, at);
    assert.equal(syscall(peer, 46, accepted, at, 0), 2n);
    assert.equal(syscall(peer, 3, received), 0n);
    const badReceive = message(slot);
    badReceive.view.setBigUint64(32, BigInt(boundary), true);
    user().copyOut(slot, badReceive.bytes);
    assert.equal(syscall(p, 47, client, slot, 0), err(E.FAULT));
    user().copyOut(slot, message(slot).bytes);
    assert.equal(syscall(p, 47, client, slot, 0x40000000), 2n);
    assert.deepEqual(user().copyIn(slot + 96, 2), Uint8Array.of(12, 34));
    const returned = new DataView(user().copyIn(slot + 88, 4).buffer).getInt32(0, true);
    assert.equal(p.fds.cloexec(returned), true);
    assert.equal(p.fds.get(returned), held);
    assert.equal(syscall(p, 0, returned, slot, 1), 1n);
    assert.equal(user().copyIn(slot, 1)[0], 42);
    assert.equal(syscall(p, 3, returned), 0n);
    assert.equal(held?.closed, true);
    assert.equal(syscall(peer, 3, accepted), 0n);
    assert.equal(syscall(p, 3, client), 0n);
  } finally {
    try { kernel.exitProcess(peer, 0); }
    finally { clean(); }
  }
  const owner: Kern = kernel;
  assert.equal(owner.sockets?.size, 0);
});

test('mapped clock, entropy and private futex wait and wake use checked guest addresses', () => {
  const {kernel, p, user, clean} = processWithVm();
  const edge = BASE + PAGE - 8, fill = new Uint8Array(16).fill(0xa5);
  try {
    assert.equal(syscall(p, 9, BASE, 2 * PAGE, 3, 0x32, -1, 0), BigInt(BASE));
    assert.equal(syscall(p, 229, 1, BASE), 0n);
    const spec = new DataView(user().copyIn(BASE, 16).buffer);
    assert.deepEqual([spec.getBigInt64(0, true), spec.getBigInt64(8, true)], [0n, 1n]);
    assert.equal(syscall(p, 228, 6, BASE), 0n);
    user().copyOut(edge, fill);
    assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 1), 0n);
    assert.equal(syscall(p, 228, 1, edge), err(E.FAULT));
    assert.deepEqual(user().copyIn(edge, 16), fill);
    assert.equal(syscall(p, 318, edge, 16, 0), 8n, 'entropy stops at the first read-only page');
    assert.deepEqual(user().copyIn(BASE + PAGE, 8), fill.subarray(8));
    assert.equal(syscall(p, 318, BASE + PAGE, 1, 0), err(E.FAULT));
    assert.equal(syscall(p, 318, BASE, 1, 16), err(E.INVAL));
    assert.equal(syscall(p, 202, edge, 0x81, 1), 0n);
    assert.equal(syscall(p, 202, edge + 1, 0x81, 1), err(E.INVAL));
    assert.equal(syscall(p, 202, 0x100, 0x81, 1), err(E.FAULT));
    const word = BASE + 32, timeout = BASE + 48;
    assert.equal(syscall(p, 202, word, 0x80, 1), err(E.AGAIN));
    assert.equal(syscall(p, 202, word, 0x80, 0, timeout), err(E.TIMEDOUT));
    assert.equal(syscall(p, 202, 0x100, 0x80, 0), err(E.FAULT));
    assert.equal(syscall(p, 202, word, 0x80, 0, BASE + 2 * PAGE - 8), err(E.FAULT));
    const invalid = new Uint8Array(16);
    new DataView(invalid.buffer).setBigInt64(8, 1000000000n, true);
    user().copyOut(timeout, invalid);
    assert.equal(syscall(p, 202, word, 0x80, 0, timeout), err(E.INVAL));
    assert.equal(syscall(p, 202, word, 0, 1), err(E.AGAIN), 'a private word can be used by pthread_join');
    assert.equal(syscall(p, 202, word, 3, 0), err(E.NOSYS));
    const addFive = 0x10005000;
    assert.equal(syscall(p, 202, word, 0x85, 1, 1, word + 4, addFive), 0n);
    assert.deepEqual(user().copyIn(word + 4, 4), Uint8Array.of(5, 0, 0, 0));
    assert.equal(syscall(p, 202, word, 0x85, 1, 1, BASE + PAGE, addFive), err(E.FAULT));
    assert.deepEqual(user().copyIn(BASE + PAGE, 8), fill.subarray(8));
    assert.equal(kernel.futexes.size, 0, 'validation and expired deadlines never publish waiters');
  } finally { clean(); }
});

test('mapped eventfd transfers one checked word and preserves the counter on a failed read', () => {
  const {p, user, clean} = processWithVm();
  try {
    assert.equal(syscall(p, 9, BASE, 2 * PAGE, 3, 0x32, -1, 0), BigInt(BASE));
    const fd = Number(syscall(p, 290, 3, 0x80800));
    assert.ok(fd >= 0);
    const input = new Uint8Array(8);
    new DataView(input.buffer).setBigUint64(0, 4n, true);
    user().copyOut(BASE, input);
    assert.equal(syscall(p, 1, fd, BASE, 8), 8n);
    assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 1), 0n);
    assert.equal(syscall(p, 0, fd, BASE + PAGE - 4, 8), err(E.FAULT));
    assert.equal(syscall(p, 0, fd, BASE, 8), 8n);
    assert.equal(new DataView(user().copyIn(BASE, 8).buffer).getBigUint64(0, true), 7n);
    assert.equal(syscall(p, 0, fd, BASE, 8), err(E.AGAIN));
    assert.equal(syscall(p, 3, fd), 0n);
  } finally { clean(); }
});

test('mapped pipe2 publishes a pair after validation and transfers only to checked memory', () => {
  const {p, user, clean} = processWithVm();
  try {
    assert.equal(syscall(p, 9, BASE, PAGE, 3, 0x32, -1, 0), BigInt(BASE));
    const count = p.fds.slots.size, limit = p.fds.limit, flags = 0x80800;
    assert.equal(syscall(p, 293, BASE + PAGE - 4, flags), err(E.FAULT));
    assert.equal(syscall(p, 293, BASE, 1), err(E.INVAL));
    p.fds.limit = p.fds.lowest() + 1;
    assert.equal(syscall(p, 293, BASE, flags), err(E.MFILE));
    p.fds.limit = limit;
    assert.equal(p.fds.slots.size, count);

    assert.equal(syscall(p, 293, BASE, flags), 0n);
    const pair = new DataView(user().copyIn(BASE, 8).buffer), r = pair.getInt32(0, true), w = pair.getInt32(4, true);
    const pipe = p.fds.get(r)!.pipe;
    assert.ok(pipe && p.fds.get(w)!.pipe === pipe);
    assert.equal(p.fds.cloexec(r) && p.fds.cloexec(w), true);
    assert.equal(syscall(p, 0, r, BASE + 16, 3), err(E.AGAIN));
    user().copyOut(BASE + 8, Uint8Array.of(4, 5, 6));
    assert.equal(syscall(p, 1, w, BASE + 8, 3), 3n);
    assert.equal(syscall(p, 0, r, BASE + PAGE, 3), err(E.FAULT));
    assert.equal(pipe.size, 3);
    assert.equal(syscall(p, 0, r, BASE + 16, 3), 3n);
    assert.deepEqual(user().copyIn(BASE + 16, 3), Uint8Array.of(4, 5, 6));
    assert.equal(syscall(p, 3, w), 0n);
    assert.equal(syscall(p, 0, r, BASE + 16, 3), 0n);
    assert.equal(syscall(p, 3, r), 0n);
    assert.deepEqual([p.fds.slots.size, pipe.readers, pipe.writers], [count, 0, 0]);
  } finally { clean(); }
});

test('mapped ppoll reads eventfd readiness and publishes only checked result fields', () => {
  const {p, user, clean} = processWithVm();
  try {
    assert.equal(syscall(p, 9, BASE, 2 * PAGE, 3, 0x32, -1, 0), BigInt(BASE));
    const fd = Number(syscall(p, 290, 3, 0x80800));
    const entries = new Uint8Array(16), view = new DataView(entries.buffer);
    view.setInt32(0, fd, true); view.setInt16(4, 1, true);
    view.setInt16(6, 0x4000, true);
    view.setInt32(8, -1, true); view.setInt16(14, 0x4000, true);
    user().copyOut(BASE, entries);
    assert.equal(syscall(p, 271, BASE, 2, BASE + 32, 0, 8), 1n);
    const result = new DataView(user().copyIn(BASE, 16).buffer);
    assert.deepEqual([result.getInt32(0, true), result.getInt16(4, true), result.getInt16(6, true), result.getInt16(14, true)],
      [fd, 1, 1, 0]);
    const crossing = BASE + PAGE - 12;
    user().copyOut(crossing, entries);
    assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 1), 0n);
    assert.equal(syscall(p, 7, crossing, 2, 0), err(E.FAULT));
    assert.deepEqual(user().copyIn(crossing, 16), entries);
  } finally { clean(); }
});

test('mapped directory reads advance only after publishing whole records', () => {
  const vfs = new Vfs();
  mountTarget(vfs).directory('/plugins', 0o755);
  fixture(vfs, '/plugins/example.so', Uint8Array.of(42));
  const {p, user, open, clean} = processWithVm(vfs);
  try {
    assert.equal(syscall(p, 9, BASE, 2 * PAGE, 3, 0x32, -1, 0), BigInt(BASE));
    assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 1), 0n);
    const fd = open('/plugins', 0x10000);
    assert.equal(syscall(p, 217, fd, BASE + PAGE - 16, 128), err(E.FAULT));
    const one = BASE + PAGE - 24;
    assert.equal(syscall(p, 217, fd, one, 128), 24n);
    assert.equal(user().copyIn(one + 19, 1)[0], 46);
    assert.equal(syscall(p, 217, fd, BASE, 128), 56n);
    const remainder = user().copyIn(BASE, 56);
    assert.equal(new TextDecoder().decode(remainder.subarray(19, 21)), '..');
    assert.equal(new TextDecoder().decode(remainder.subarray(43, 53)), 'example.so');
    assert.equal(syscall(p, 217, fd, BASE, 128), 0n);
  } finally { clean(); }
});

test('ordinary mprotect can only reduce initial load data and never move the mmap floor', () => {
  const base = BASE + 12 * PAGE, early = BASE + PAGE, middle = early + PAGE, tail = BASE + 4 * PAGE;
  const besideStack = BASE + 7 * PAGE, stack = besideStack + PAGE;
  const initial: NonNullable<Parameters<typeof MappedVm.allocate>[1]> = {verify() {}, regions: [
    {kind: 'load-data', start: BASE, end: early, prot: 1, writes: []},
    {kind: 'load-data', start: early, end: tail, prot: 3, writes: [{at: middle + 8, bytes: Uint8Array.of(42)}]},
    {kind: 'load-data', start: tail, end: tail + PAGE, prot: 3, writes: []},
    {kind: 'load-data', start: besideStack, end: stack, prot: 3, writes: []},
    {kind: 'stack', start: stack, end: stack + PAGE, prot: 3, writes: []},
  ]};
  const {kernel, p, vm, user, clean} = processWithVm(new Vfs(), {base, initial});
  const access = (at: number, what: 'read' | 'write') => vm.code.permits(BigInt(at), 1n, what);
  try {
    assert.deepEqual([kernel.tasks.size, kernel.runq.length], [0, 0]);
    const before = user(), generation = vm.code.generation;
    assert.equal(syscall(p, 10, tail, 2 * PAGE, 1), err(E.NOMEM), 'mprotect does not bridge a bootstrap hole');
    assert.equal(syscall(p, 10, besideStack, 2 * PAGE, 1), err(E.ACCES), 'a stack cannot be included');
    assert.equal(syscall(p, 10, early + 1, PAGE, 1), err(E.INVAL));
    before.check(); // none of the rejections touched the live address space
    assert.equal(access(tail, 'write'), true);
    assert.equal(access(besideStack, 'write'), true);
    assert.equal(access(stack, 'write'), true);

    assert.equal(syscall(p, 10, middle, 1, 1), 0n, 'round the length to one page');
    assert.throws(() => before.check(), ReadLifetimeError);
    assert.deepEqual(user().copyIn(middle + 8, 1), Uint8Array.of(42));
    assert.equal(access(middle + PAGE - 1, 'write'), false);
    assert.equal(access(early, 'write'), true);
    assert.equal(access(middle + PAGE, 'write'), true);
    assert.throws(() => user().copyOut(middle + 8, Uint8Array.of(7)),
      (error: unknown) => error instanceof FsError && error.errno === E.FAULT);
    assert.equal(syscall(p, 10, early, 4 * PAGE, 1), 0n, 'split and adjacent data rows remain protectable');
    assert.equal(access(tail, 'write'), false);
    const readOnly = user();
    assert.equal(syscall(p, 10, early, 4 * PAGE, 1), 0n);
    readOnly.check();
    assert.equal(syscall(p, 10, early, 1, 0), 0n);
    assert.equal(access(early, 'read'), false);
    assert.equal(syscall(p, 10, early, 4 * PAGE, 1), err(E.ACCES), 'no restoring even read permission');
    assert.equal(syscall(p, 10, middle, PAGE, 3), err(E.ACCES));
    assert.equal(syscall(p, 10, middle, PAGE, 5), err(E.ACCES));
    assert.equal(syscall(p, 10, BASE, PAGE, 3), err(E.ACCES), 'original rodata stays read-only');
    assert.equal(vm.code.generation, generation);
    assert.deepEqual(user().copyIn(middle + 8, 1), Uint8Array.of(42));

    assert.equal(syscall(p, 9, middle, PAGE, 3, 0x32, -1, 0), err(E.INVAL));
    assert.equal(syscall(p, 9, middle, PAGE, 3, 0x100022, -1, 0), err(E.INVAL));
    assert.equal(syscall(p, 11, middle, PAGE), err(E.INVAL));
    assert.equal(syscall(p, 10, stack, base + PAGE - stack, 1), err(E.INVAL), 'no bootstrap/arena crossing');
    assert.equal(syscall(p, 9, 0, PAGE, 3, 0x22, -1, 0), BigInt(base));
    assert.equal(syscall(p, 9, stack, PAGE, 3, 0x22, -1, 0), BigInt(base + PAGE));
    assert.equal(access(stack + PAGE, 'read'), false, 'a low hint cannot allocate a bootstrap guard');
    assert.deepEqual(user().copyIn(middle + 8, 1), Uint8Array.of(42));
  } finally { clean(); }
});

test('ordinary mmap source failure, descriptor replacement and destination retirement do not publish candidate bytes', () => {
  const vfs = new Vfs();
  const {p, memory, user, open, clean} = processWithVm(vfs);
  let fd = -1;
  fixture(vfs, '/ordinary', encode.encode('data'));
  fixture(vfs, '/io', encode.encode('err'), () => { throw new Error('ordinary file unavailable'); });
  fixture(vfs, '/drop', encode.encode('bad'), () => { assert.equal(syscall(p, 3, fd), 0n); return encode.encode('bad'); });
  fixture(vfs, '/stale', encode.encode('bad'), () => { p.memory = null; return encode.encode('bad'); });
  try {
    fd = open('/ordinary');
    assert.equal(syscall(p, 9, 0, PAGE, 3, 2, fd, 0), BigInt(BASE));
    assert.equal(Buffer.from(user().copyIn(BASE, 4)).toString(), 'data');
    fd = open('/io');
    assert.equal(syscall(p, 9, BASE, PAGE, 1, 0x12, fd, 0), err(E.IO));
    fd = open('/drop');
    assert.equal(syscall(p, 9, BASE, PAGE, 1, 0x12, fd, 0), err(E.BADF));
    assert.equal(Buffer.from(user().copyIn(BASE, 4)).toString(), 'data');
    fd = open('/stale');
    assert.throws(() => syscall(p, 9, BASE, PAGE, 1, 0x12, fd, 0), ReadLifetimeError);
    assert.equal(p.state, 'zombie');
    assert.equal(Buffer.from(memory.buffer, BASE, 4).toString(), 'data');
  } finally { clean(); }
});

test('private library mappings keep their source snapshot through guest memory growth', () => {
  const vfs = new Vfs(), original = Buffer.from([11, 12, 13]);
  const {file, source} = fixture(vfs, '/library.so', original);
  const {p, open, memory, user, clean} = processWithVm(vfs, {sources: [source]});
  try {
    const fd = open('/library.so'), at = memory.buffer.byteLength;
    const grow = memory.grow.bind(memory);
    memory.grow = pages => { file.write(0, Uint8Array.of(99)); return grow(pages); };
    assert.equal(syscall(p, 9, at, PAGE, 3, 0x12, fd, 0), BigInt(at));
    assert.deepEqual(user().copyIn(at, 4), Uint8Array.of(11, 12, 13, 0));
    assert.deepEqual(file.read(0, 3), Uint8Array.of(99, 12, 13));
    assert.deepEqual(original, Buffer.from([11, 12, 13]));
    user().copyOut(at + 1, Uint8Array.of(42));
    assert.deepEqual(file.read(0, 3), Uint8Array.of(99, 12, 13));
  } finally { clean(); }
});

test('private library mappings take an independent snapshot of an aliased guest buffer', () => {
  const vfs = new Vfs(), original = Uint8Array.of(21, 22, 23);
  let backing: ArrayBuffer;
  const {source} = fixture(vfs, '/alias.so', original, () => Buffer.from(backing, NAME + 32, original.length));
  const {p, open, memory, user, clean} = processWithVm(vfs, {sources: [source]});
  try {
    backing = memory.buffer;
    const at = backing.byteLength;
    user().copyOut(NAME + 32, original);
    const fd = open('/alias.so');
    assert.equal(syscall(p, 9, at, PAGE, 3, 0x12, fd, 0), BigInt(at));
    assert.notEqual(memory.buffer, backing);
    assert.deepEqual(user().copyIn(at, 4), Uint8Array.of(21, 22, 23, 0));
  } finally { clean(); }
});

test('cold private pages preserve offsets and zero tails through protection changes and replacement', () => {
  const vfs = new Vfs(), bytes = new Uint8Array(4 * PAGE - 1);
  for (let page = 0; page < 4; page++) bytes.fill(page + 1, page * PAGE, (page + 1) * PAGE);
  const {file, source} = fixture(vfs, '/owned.so', bytes, () => bytes.slice(), 'owned');
  const {kernel, p, open, memory, user, clean} = processWithVm(vfs, {sources: [source]});
  p.pid = 1;
  kernel.procs.set(p.pid, p);
  try {
    const fd = open('/owned.so'), raw = () => new Uint8Array(memory.buffer);
    assert.equal(syscall(p, 9, BASE, 4 * PAGE, 3, 0x32, -1, 0), BigInt(BASE));
    user().copyOut(BASE + 3 * PAGE, new Uint8Array(PAGE).fill(99));
    assert.equal(syscall(p, 9, BASE, 4 * PAGE, 0, 0x12, fd, 0), BigInt(BASE));
    assert.equal(syscall(p, 3, fd), 0n);
    assert.equal(kernel.free().after.files, bytes.length, 'a live private mapping owns this loaded snapshot');
    assert.equal(raw()[BASE + 4 * PAGE - 1], 0, 'replacement leaves the partial last page backed by zeros');
    assert.equal(syscall(p, 10, BASE + PAGE, 2 * PAGE, 1), 0n);
    assert.equal(syscall(p, 10, BASE, PAGE, 1), 0n);
    assert.equal(raw()[BASE + PAGE], 0, 'mprotect does not fault in a page');
    file.write(PAGE, Uint8Array.of(42));
    assert.deepEqual(user().copyIn(BASE + PAGE - 1, 2), Uint8Array.of(1, 2));
    assert.equal(raw()[BASE + 2 * PAGE], 0, 'adjacent cold page stays uninitialized');
    assert.equal(syscall(p, 10, BASE + 2 * PAGE, PAGE, 3), 0n);
    user().copyOut(BASE + 2 * PAGE + 1, Uint8Array.of(8));
    assert.deepEqual(user().copyIn(BASE + 2 * PAGE, 3), Uint8Array.of(3, 8, 3));
    assert.equal(file.read(2 * PAGE + 1, 2 * PAGE + 2)[0], 3);
    assert.equal(syscall(p, 11, BASE + PAGE, PAGE), 0n);
    assert.equal(syscall(p, 9, BASE + PAGE, PAGE, 3, 0x32, -1, 0), BigInt(BASE + PAGE));
    assert.equal(user().copyIn(BASE + PAGE, 1)[0], 0);
    assert.equal(syscall(p, 10, BASE + 3 * PAGE, PAGE, 1), 0n);
    assert.deepEqual(user().copyIn(BASE + 4 * PAGE - 2, 2), Uint8Array.of(4, 0));
  } finally { clean(); }
});

test('an untouched private mapping stops pinning its file when unmapped', () => {
  const vfs = new Vfs(), bytes = new Uint8Array(PAGE);
  const {source} = fixture(vfs, '/owned.so', bytes, () => bytes.slice(), 'owned');
  const {kernel, p, open, clean} = processWithVm(vfs, {sources: [source]});
  p.pid = 1;
  kernel.procs.set(p.pid, p);
  try {
    const fd = open('/owned.so');
    assert.equal(syscall(p, 9, BASE, PAGE, 1, 0x12, fd, 0), BigInt(BASE));
    assert.equal(syscall(p, 3, fd), 0n);
    assert.equal(kernel.free().after.files, bytes.length);
    assert.equal(syscall(p, 11, BASE, PAGE), 0n);
    assert.equal(kernel.free().after.files, 0);
  } finally { clean(); }
});

test('checked copies use installed spans, independent snapshots, and the live mapping lifetime', () => {
  const {p, user, vm, clean} = processWithVm();
  const faults = (e: unknown) => e instanceof FsError && e.errno === E.FAULT;
  try {
    assert.throws(() => p.bytes, /checked kernel copy/);
    assert.throws(() => p.view, /checked kernel copy/);
    assert.equal(vm.permits(BigInt(BASE), 1n, 'read'), false, 'linear memory capacity is not mapping authority');
    assert.equal(syscall(p, 9, BASE, 2 * PAGE, 3, 0x32, -1, 0), BigInt(BASE));
    const edge = BASE + PAGE - 2, data = Uint8Array.of(1, 2, 3, 4);
    const first = user();
    first.copyOut(edge, data);
    const snapshot = first.copyIn(edge, 4);
    snapshot.fill(9);
    assert.deepEqual(first.copyIn(edge, 4), data, 'copy-in never lends an alias of mapped memory');
    assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 1), 0n);
    assert.throws(() => first.copyIn(edge, 1), ReadLifetimeError, 'data-only mapping changes invalidate a held copy');
    const current = user();
    assert.equal(current.prefix(edge, 4, 'read'), 4, 'compatible adjacent spans are one readable prefix');
    assert.equal(current.prefix(edge, 4, 'write'), 2);
    assert.equal(vm.permits(BigInt(edge), 4n, 'write'), false);
    assert.equal(vm.permits(BigInt(edge), 4n, 'read'), true);
    assert.equal(vm.permits(BigInt(edge) + (1n << 32n), 4n, 'read'), false);
    assert.throws(() => current.copyOut(edge, Uint8Array.of(9, 9, 9, 9)), faults);
    assert.deepEqual(current.copyIn(edge, 4), data, 'checked copy-out does not publish a prefix of a refused whole copy');
    assert.throws(() => current.copyIn(BASE, MAPPED_COPY_LIMIT + 1), e => e instanceof FsError && e.errno === E.INVAL);
    assert.deepEqual(current.copyIn(-1, 0), new Uint8Array(0), 'a zero-size operation probes no address');
    assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 0), 0n);
    assert.equal(vm.permits(BigInt(edge), 4n, 'read'), false);
    assert.throws(() => user().copyIn(edge, 4), faults);
  } finally { clean(); }
  assert.equal(vm.permits(BigInt(BASE), 1n, 'read'), false);
  assert.throws(user, ReadLifetimeError);
});

test('a clear-tid receipt cannot follow an owner epoch even on the same backing', () => {
  const {p, vm, memory, user, clean} = processWithVm();
  try {
    assert.equal(syscall(p, 9, BASE, PAGE, 3, 0x32, -1, 0), BigInt(BASE));
    const prior = Uint8Array.of(1, 2, 3, 4);
    user().copyOut(BASE, prior);
    const clear = vm.prepareTidClear(p, BASE);
    assert.ok(clear);
    p.memory = memory; // Same identity of the backing, different process lifetime.
    vm.close();
    assert.throws(clear, ReadLifetimeError);
    assert.throws(clear, ReadLifetimeError, 'failure still consumes the receipt');
    assert.deepEqual(new Uint8Array(memory.buffer, BASE, 4), prior);
  } finally { clean(); }
});

test('ordinary mapped read, pread, write, stat and console use bounded checked kernel copies', () => {
  const vfs = new Vfs(), printed: [number, string][] = [];
  const data = encode.encode('ricebox');
  fixture(vfs, '/input', data);
  const {p, user, open, clean} = processWithVm(vfs, {write: (fd, bytes) => printed.push([fd, Buffer.from(bytes).toString()])});
  try {
    const input = open('/input'), output = open('/output', 0x42);
    assert.equal(syscall(p, 9, BASE, 2 * PAGE, 3, 0x32, -1, 0), BigInt(BASE));
    const after = BASE + PAGE, edge = after - 3;
    user().copyOut(after, encode.encode('kept'));
    assert.equal(syscall(p, 10, after, PAGE, 1), 0n);
    assert.equal(syscall(p, 0, input, edge, 7), 3n);
    assert.equal(p.fds.get(input)?.offset, 3);
    assert.equal(Buffer.from(user().copyIn(edge, 7)).toString(), 'rickept');
    assert.equal(syscall(p, 17, input, BASE, 7, 0), 7n);
    assert.equal(p.fds.get(input)?.offset, 3, 'pread does not transfer ownership of the existing offset');
    assert.equal(syscall(p, 0, input, after, 1), err(E.FAULT));
    assert.equal(syscall(p, 0, input, -1, 0), 0n);
    assert.equal(syscall(p, 1, output, BASE, 7), 7n);
    assert.equal(syscall(p, 18, output, after, 4, 0), 4n, 'write may read a read-only page');
    assert.equal(p.fds.get(output)?.offset, 7);
    assert.equal(Buffer.from(vfs.readFile('/output')).toString(), 'keptbox');
    const out = p.fds.install(new Description('console', {flags: 1, path: 'stdout'}));
    assert.equal(syscall(p, 1, out, BASE, 7), 7n);
    assert.deepEqual(printed, [[1, 'ricebox']]);
    assert.equal(syscall(p, 5, input, BASE + 16), 0n);
    assert.equal(new DataView(user().copyIn(BASE + 16, 144).buffer).getBigUint64(48, true), 7n);
    assert.equal(syscall(p, 5, input, edge), err(E.FAULT), 'an output struct crosses no unwritable page');
    assert.equal(syscall(p, 10, after, PAGE, 0), 0n);
    assert.equal(syscall(p, 1, output, after, 1), err(E.FAULT));
    assert.equal(syscall(p, 19, input, BASE, 1), err(E.NOSYS), 'an unported iovec cannot reach the old raw copy');
    assert.equal(syscall(p, 79, BASE, 16), err(E.NOSYS), 'an unported buffer syscall is not a fallback');
    assert.equal(p.call, null);
    assert.equal(p.fds.get(output)?.offset, 7);
  } finally { clean(); }
});

test('mapped console writev checks every vector before delivering one write', () => {
  const printed: [number, string][] = [];
  const {p, user, clean} = processWithVm(new Vfs(), {write: (fd, bytes) => printed.push([fd, Buffer.from(bytes).toString()])});
  try {
    const fd = p.fds.install(new Description('console', {flags: 1, path: 'stdout'}));
    const first = BASE, second = BASE + PAGE, a = encode.encode('dynamic-pie:42');
    assert.equal(syscall(p, 9, BASE, 2 * PAGE, 3, 0x32, -1, 0), BigInt(BASE));
    user().copyOut(first, a);
    user().copyOut(second, Uint8Array.of(10));
    const entries = new Uint8Array(32), table = new DataView(entries.buffer);
    table.setBigUint64(0, BigInt(first), true);
    table.setBigUint64(8, BigInt(a.length), true);
    table.setBigUint64(16, BigInt(second), true);
    table.setBigUint64(24, 1n, true);
    user().copyOut(NAME, entries);
    assert.equal(syscall(p, 20, fd, NAME, 2), BigInt(a.length + 1));
    assert.deepEqual(printed, [[1, 'dynamic-pie:42\n']]);

    assert.equal(syscall(p, 10, second, PAGE, 0), 0n);
    assert.equal(syscall(p, 20, fd, NAME, 2), err(E.FAULT), 'a bad later buffer publishes no prefix');
    assert.equal(syscall(p, 20, fd, NAME + PAGE - 16, 2), err(E.FAULT), 'the whole vector table must be readable');
    assert.equal(syscall(p, 20, fd, 0, 1025), err(E.INVAL));
    assert.equal(syscall(p, 20, fd, 0, 0), 0n);
    table.setBigInt64(24, -1n, true);
    user().copyOut(NAME, entries);
    assert.equal(syscall(p, 20, fd, NAME, 2), err(E.INVAL));
    assert.equal(printed.length, 1);
  } finally { clean(); }
});

test('path input is terminated in readable memory and transfer size is bounded', () => {
  const vfs = new Vfs(), input = new Uint8Array(MAPPED_COPY_LIMIT + 16).fill(42);
  fixture(vfs, '/ordinary', input);
  const {p, user, open, clean} = processWithVm(vfs);
  try {
    assert.equal(syscall(p, 9, BASE, 2 * PAGE, 3, 0x32, -1, 0), BigInt(BASE));
    const edge = BASE + PAGE - 4;
    user().copyOut(edge, encode.encode('/ordinary\0'));
    const fd = Number(syscall(p, 257, -100, edge, 0));
    assert.ok(fd >= 0, 'a terminated path can span two readable pages');
    const denied = '/absent';
    user().copyOut(edge, encode.encode(denied + '\0'));
    assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 0), 0n);
    assert.equal(syscall(p, 2, edge, 0x42), err(E.FAULT));
    assert.equal(syscall(p, 2, BASE - 1, 0), err(E.FAULT));
    user().copyOut(BASE, new Uint8Array(PAGE).fill(97));
    assert.equal(syscall(p, 2, BASE, 0), err(E.NAMETOOLONG));
    assert.equal(syscall(p, 2, 1, 0), err(E.FAULT));
    assert.equal(syscall(p, 2, NAME, 0), err(E.NOENT));
    assert.throws(() => vfs.lookup(denied), (e: unknown) => e instanceof FsError && e.errno === E.NOENT);
    assert.equal(syscall(p, 9, 0x80000, MAPPED_COPY_LIMIT + PAGE, 3, 0x32, -1, 0), 0x80000n);
    assert.equal(syscall(p, 0, open('/ordinary'), 0x80000, input.length), BigInt(MAPPED_COPY_LIMIT));
    assert.equal(user().copyIn(0x80000 + MAPPED_COPY_LIMIT - 1, 2).join(','), '42,0');
  } finally { clean(); }
});

for (const change of ['data mapping', 'offset ABA'] as const) {
  test(`a lazy read losing its ${change} cannot publish bytes or an offset`, () => {
    const vfs = new Vfs();
    const {p, memory, vm, user, open, clean} = processWithVm(vfs);
    let fd = -1;
    fixture(vfs, '/late', encode.encode('copy'), () => {
      if (change === 'data mapping') {
        const code = vm.code.generation;
        assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 1), 0n);
        assert.equal(vm.code.generation, code);
      } else {
        assert.equal(syscall(p, 8, fd, 1, 0), 1n);
        assert.equal(syscall(p, 8, fd, 0, 0), 0n);
      }
      return encode.encode('copy');
    });
    try {
      assert.equal(syscall(p, 9, BASE, 2 * PAGE, 3, 0x32, -1, 0), BigInt(BASE));
      user().copyOut(BASE, encode.encode('keep'));
      fd = open('/late');
      const d = p.fds.get(fd)!;
      assert.throws(() => syscall(p, 0, fd, BASE, 4), ReadLifetimeError);
      assert.equal(d.offset, 0);
      assert.equal(Buffer.from(memory.buffer, BASE, 4).toString(), 'keep');
      assert.equal(p.state, 'zombie');
      assert.equal(p.memory, null);
    } finally { clean(); }
  });
}

test('a lazy writable file is not changed when copy-in loses its owner during preparation', () => {
  const vfs = new Vfs();
  const {p, user, open, clean} = processWithVm(vfs);
  const initial = encode.encode('old!');
  const {file} = fixture(vfs, '/output', initial, () => {
    assert.equal(syscall(p, 10, BASE, PAGE, 1), 0n);
    return initial;
  });
  try {
    assert.equal(syscall(p, 9, BASE, PAGE, 3, 0x32, -1, 0), BigInt(BASE));
    user().copyOut(BASE, encode.encode('next'));
    const fd = open('/output', 2), description = p.fds.get(fd)!;
    assert.throws(() => syscall(p, 1, fd, BASE, 4), ReadLifetimeError);
    assert.equal(description.offset, 0);
    assert.equal(Buffer.from(file.bytes()).toString(), 'old!');
    assert.equal(p.memory, null);
  } finally { clean(); }
});

function textMap(spec: ElfLoadSpec, bias: number) {
  const text = spec.loads.find(s => s.flags === 5)!;
  assert.ok(text);
  const page = (n: number) => Math.floor(n / PAGE) * PAGE;
  return {addr: bias + page(text.vaddr), offset: page(text.offset),
    length: Math.ceil((text.vaddr + text.fileSize) / PAGE) * PAGE - page(text.vaddr),
    pc: bias + text.vaddr};
}

test('mapped FXSR transfers the architectural state and checks the full image before changing it', {skip}, async t => {
  const vfs = new Vfs(), translate = await loadTranslator(readFileSync(wasm!));
  const scratch = mkdtempSync(join(tmpdir(), 'sods-fxsr-'));
  const src = fileURLToPath(new URL('../fixtures/mapped-code/fxsr.S', import.meta.url));
  const dst = join(scratch, 'fxsr.so');
  t.after(() => rmSync(scratch, {recursive: true, force: true}));
  execFileSync(process.env.SODS_FIXTURE_CC ?? 'cc', ['-nostdlib', '-shared', '-fPIC', '-s',
    '-Wl,-e,fxsr,--build-id=none', src, '-o', dst], {timeout: 6_000});
  const binary = new Uint8Array(readFileSync(dst)), lib = fixture(vfs, '/fxsr.so', binary);
  const {p, code, user, open, clean} = processWithVm(vfs, {sources: [lib.source], translate});
  const {addr, length, offset, pc} = textMap(translate.describeDynamic!(binary, 'library'), 0x30000);
  const coprocessor = new X87(translate.module!);
  const make = t.mock.method(coprocessor, 'make'), free = t.mock.method(coprocessor, 'free');
  const finished = new Error('Completed FXSR fixture');
  const unsupported = new Error('Unsupported SSE mode');
  const imports = {
    syscall(nr: bigint) { assert.equal(nr, 231n); throw finished; },
    trap(at: bigint, reason: number) {
      assert.equal(reason, 3, `unexpected trap at ${at.toString(16)}`);
      throw unsupported;
    },
    div128() { assert.fail('unused div128'); }, clock: () => 0n, time: () => NaN, trace() {},
  };
  const compiler = translate.mapped!;
  const dispatcher = new MappedDispatcher(code, compiler, imports, () => coprocessor);
  const image = BASE, out = BASE + 512, edge = BASE + PAGE - 480;
  const xmm = Uint8Array.from({length: 256}, (_, i) => (i * 17 + 1) & 255);
  const fill = (at: number, n = 512) => user().copyOut(at, new Uint8Array(n).fill(0xa5));
  const enter = (mode: number, input = image, output = out) => {
    dispatcher.setReg('r7', BigInt(input));
    dispatcher.setReg('r6', BigInt(output));
    dispatcher.setReg('r2', BigInt(mode));
    return () => dispatcher.run(BigInt(pc));
  };
  const run = (mode: number) => assert.throws(enter(mode), error => error === finished);
  const read = () => user().copyIn(out, 512);
  try {
    assert.equal(syscall(p, 9, addr, length, 5, 0x12, open('/fxsr.so'), offset), BigInt(addr));
    assert.equal(syscall(p, 9, BASE, 2 * PAGE, 3, 0x32, -1, 0), BigInt(BASE));
    assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 0), 0n);
    user().copyOut(image, xmm);
    fill(out);
    run(0);
    const initial = read(), state = new DataView(initial.buffer);
    assert.equal(state.getUint16(0, true), 0x037f);
    assert.equal(state.getUint16(2, true), 6 << 11);
    assert.equal(initial[4], 0xc0, 'physical tags of ST0 and ST1 at TOP 6');
    assert.equal(state.getUint16(6, true), 0x1ee, 'FLDZ escape and ModRM');
    const fip = state.getBigUint64(8, true);
    assert.ok(fip >= BigInt(pc) && fip < BigInt(pc + length));
    assert.deepEqual(user().copyIn(Number(fip), 2), Uint8Array.of(0xd9, 0xee));
    assert.equal(state.getUint32(24, true), 0x1f80);
    assert.equal(state.getUint32(28, true), 0xffbf);
    assert.deepEqual(initial.slice(32, 42), new Uint8Array(10));
    assert.equal(state.getBigUint64(48, true), 0x8000_0000_0000_0000n);
    assert.equal(state.getUint16(56, true), 0x3fff);
    assert.deepEqual(initial.slice(160, 176), xmm.slice(0, 16));
    assert.deepEqual(initial.slice(400, 416), xmm.slice(240));
    assert.deepEqual(initial.slice(464), new Uint8Array(48).fill(0xa5));

    state.setUint16(0, 0x077f, true);
    state.setUint16(2, 3 << 11, true);
    initial[4] = 0x08;
    state.setBigUint64(8, 0x1234_5678_9abc_def0n, true);
    state.setBigUint64(16, 0xfedc_ba98_7654_3210n, true);
    state.setUint32(24, 0x3fa0, true);
    initial.fill(0x42, 32, 42);
    initial.set(xmm, 160);
    user().copyOut(image, initial);
    run(1);
    assert.deepEqual(read().slice(0, 416), initial.slice(0, 416));
    assert.deepEqual(read().slice(464), new Uint8Array(48).fill(0xa5));

    const legacy = initial.slice(), legacyView = new DataView(legacy.buffer);
    legacyView.setUint32(12, 0x33, true);
    legacyView.setUint32(20, 0x2b, true);
    user().copyOut(image, legacy);
    run(2);
    assert.deepEqual(read().slice(0, 416), legacy.slice(0, 416), 'legacy form also restores XMM8–15');

    user().copyOut(image, Uint8Array.of(0xa0, 0x5f, 0, 0));
    run(3);
    assert.deepEqual(read().subarray(0, 4), Uint8Array.of(0xa0, 0x5f, 0, 0));
    run(4);
    const committed = read().slice(0, 416);
    fill(edge, 480);
    const fault = (access: 'read' | 'write') => (e: unknown) =>
      e instanceof MappedDataFault && e.address === BigInt(edge) && e.length === 512 && e.access === access;
    assert.throws(enter(4, image, edge), fault('write'));
    assert.deepEqual(user().copyIn(edge, 480), new Uint8Array(480).fill(0xa5));
    assert.throws(enter(1, edge), fault('read'));
    assert.throws(enter(4, image, out + 1), /Unaligned/);
    assert.throws(enter(1, image + 1), /Unaligned/);
    legacyView.setUint32(24, 0x0001_0000, true);
    user().copyOut(image, legacy);
    assert.throws(enter(1), /Reserved MXCSR/);
    assert.throws(enter(5), error => error === unsupported);
    run(4);
    assert.deepEqual(read().slice(0, 416), committed);

    user().copyOut(image, Uint8Array.of(0x7f, 0x0b));
    fill(out);
    run(6);
    assert.deepEqual(read().subarray(0, 5), Uint8Array.of(0x7f, 0x0b, 0, 0x18, 0xa5));
    const last = BASE + PAGE - 1;
    user().copyOut(last, Uint8Array.of(0x42));
    const wordFault = (access: 'read' | 'write') => (e: unknown) =>
      e instanceof MappedDataFault && e.address === BigInt(last) && e.length === 2 && e.access === access;
    assert.throws(enter(6, last), wordFault('read'));
    assert.throws(enter(7, image, last), wordFault('write'));
    assert.equal(user().copyIn(last, 1)[0], 0x42);
    run(7);
    assert.deepEqual(read().subarray(0, 2), Uint8Array.of(0x7f, 0x0b));
    run(4);
    assert.deepEqual(read().subarray(6, 24), committed.subarray(6, 24));
    assert.equal(make.mock.callCount(), 1);
    dispatcher.close();
    assert.equal(free.mock.callCount(), 1);
    assert.deepEqual(free.mock.calls[0]?.arguments, [make.mock.calls[0]?.result]);

    const lost = new Error('Compiler retirement confirmation lost');
    const failure = new MappedDispatcher(code, {...compiler, close(known) {
      compiler.close(known);
      throw lost;
    }}, imports, () => coprocessor);
    try {
      failure.setReg('r6', BigInt(out));
      failure.setReg('r2', 4n);
      assert.throws(() => failure.run(BigInt(pc)), error => error === finished);
    } finally {
      const retained = (error: unknown) => error instanceof AggregateError && error.errors[0] === lost;
      assert.throws(() => failure.close(), retained);
      assert.throws(() => failure.close(), retained);
    }
    assert.equal(free.mock.callCount(), 2, 'the unwound x87 owner retires even when code retirement is unconfirmed');
    assert.deepEqual(free.mock.calls[1]?.arguments, [make.mock.calls[1]?.result]);
  } finally {
    try { dispatcher.close(); } finally { clean(); }
  }
});

test('actual mmap syscalls authorize the pinned Debian fixture DSO and revoke before changes, no interpreter run', {
  skip: !officialRoot || !wasm ? 'requires the staged official fixture and mapped-code translator' : false,
}, async () => {
  const vfs = new Vfs(), t = await loadTranslator(readFileSync(wasm!));
  const lib = '/usr/lib/x86_64-linux-gnu/libricebox-pie-fixture.so.1', glibc = '/usr/lib/x86_64-linux-gnu/libc.so.6';
  const bytes = new Uint8Array(readFileSync(join(officialRoot!, lib))), libc = new Uint8Array(readFileSync(join(officialRoot!, glibc)));
  assert.equal(createHash('sha256').update(libc).digest('hex'), 'cc7377e8816cefadbb4ee083f5387f67a4a883d90bc273160842a6ac075af662');
  const a = fixture(vfs, lib, bytes), b = fixture(vfs, glibc, libc);
  fixture(vfs, '/untrusted.so', bytes);
  const invalid = fixture(vfs, '/invalid.so', encode.encode('not an ELF'));
  const {kernel, p, user, open, code, clean} = processWithVm(vfs, {
    base: 0x20000, sources: [a.source, b.source, invalid.source], translate: t,
    initial: {verify() {}, regions: [{kind: 'load-data', start: BASE, end: BASE + PAGE, prot: 3, writes: []}]},
  });
  try {
    const m = textMap(t.describeDynamic!(bytes, 'library'), 0x20000);
    const load = (fd: number) => syscall(p, 9, m.addr, m.length, 5, 0x812, fd, m.offset);
    const fd = open(lib);
    assert.equal(load(fd), BigInt(m.addr));
    const epoch = code.generation, bound = code.find(BigInt(m.pc), epoch);
    assert.ok(bound);
    assert.equal(syscall(p, 10, BASE, PAGE, 1), 0n);
    assert.equal(code.generation, epoch, 'initial data-only mprotect does not discard authenticated DSO code');
    assert.equal(code.find(BigInt(m.pc), epoch), bound);
    const length = bound.text.length;
    assert.equal(Buffer.compare(Buffer.from(user().copyIn(m.pc, length)), Buffer.from(bytes.subarray(m.offset, m.offset + length))), 0);
    assert.equal(syscall(p, 0, fd, m.pc, 1), err(E.FAULT), 'ordinary copy-out cannot modify an authorized RX page');
    assert.equal(load(open('/untrusted.so')), err(E.ACCES), 'matching file content does not grant another inode authority');
    assert.equal(load(open('/invalid.so')), err(E.NOEXEC), 'an authorized path is not sufficient for malformed ELF');
    assert.equal(load(open(lib, 0x200000)), err(E.BADF), 'O_PATH is not a readable descriptor');
    assert.equal(load(open(lib, 2)), err(E.ACCES), 'mapping code needs a read-only description');
    assert.equal(syscall(p, 9, m.addr, m.length, 7, 0x12, fd, m.offset), err(E.ACCES));
    assert.equal(syscall(p, 9, m.addr, m.length, 5, 0x11, fd, m.offset), err(E.OPNOTSUPP));
    assert.equal(syscall(p, 9, m.addr, m.length, 5, 0x12, fd, 0), err(E.ACCES), 'data pages cannot become instructions');
    assert.equal(code.generation, epoch, 'refusal is before replacement of an existing RX mapping');
    assert.equal(syscall(p, 3, fd), 0n);
    assert.equal(code.find(BigInt(m.pc), epoch), bound, 'a live mapping survives descriptor close');
    assert.equal(syscall(p, 10, m.addr, m.length, 5), 0n);
    assert.equal(code.generation, epoch, 'a protection no-op retains the current generation');
    assert.equal(syscall(p, 10, m.addr, m.length, 1), 0n);
    assert.throws(() => code.find(BigInt(m.pc), epoch), MappedCodeChanged);
    assert.equal(code.find(BigInt(m.pc), code.generation), undefined);
    assert.equal(syscall(p, 10, m.addr, m.length, 5), err(E.ACCES), 'mprotect cannot reissue a code grant');
    assert.equal(load(open(lib)), BigInt(m.addr), 'fresh authenticated mmap reissues exact text');
    const pinned = code.generation, mount = kernel.root.mnt;
    mount.flags |= MNT.NOEXEC;
    assert.equal(load(open(lib)), err(E.PERM));
    mount.flags &= ~MNT.NOEXEC;
    assert.throws(() => code.find(BigInt(m.pc), pinned), MappedCodeChanged, 'NOEXEC ABA invalidates even without intermediate dispatch');
    const libcMap = textMap(t.describeDynamic!(libc, 'library'), 0x60000);
    assert.equal(syscall(p, 9, libcMap.addr, libcMap.length, 5, 0x12, open(glibc), libcMap.offset), BigInt(libcMap.addr));
    const libcBound = code.find(BigInt(libcMap.pc), code.generation);
    assert.ok(libcBound);
    assert.equal(syscall(p, 11, libcMap.addr + PAGE, 1), 0n, 'partial unmap withdraws the complete exact-text binding');
    assert.equal(code.find(BigInt(libcMap.pc), code.generation), undefined);
    assert.equal(syscall(p, 10, libcMap.addr, PAGE, 5), err(E.ACCES));
    assert.equal(syscall(p, 9, m.addr, m.length, 3, 0x32, -1, 0), BigInt(m.addr), 'fixed non-exec replacement publishes no code');
    assert.equal(code.find(BigInt(m.pc), code.generation), undefined);
  } finally { clean(); }
});

test('one real mprotect unwinds the old frame, restores RAX, RCX and flags, and reuses live code', {skip}, async () => {
  const vfs = new Vfs(), t = await loadTranslator(readFileSync(wasm!)), compiler = t.mapped!;
  const scratch = mkdtempSync(join(tmpdir(), 'sods-vm-'));
  try {
    const cc = process.env.SODS_FIXTURE_CC ?? 'cc';
    const build = (name: 'resume' | 'result') => {
      const src = fileURLToPath(new URL(`../fixtures/mapped-code/${name}.S`, import.meta.url)), dst = join(scratch, name);
      execFileSync(cc, ['-nostdlib', '-shared', '-fPIC', '-s', '-DAMOUNT=0',
        `-Wl,-e,${name},--build-id=none`, src, '-o', dst], {timeout: 6_000});
      return new Uint8Array(readFileSync(dst));
    };
    const a = build('resume'), b = build('result');
    const first = fixture(vfs, '/one.so', a), second = fixture(vfs, '/two.so', b);
    const {p, code, open, clean} = processWithVm(vfs, {sources: [first.source, second.source], translate: t});
    const m = textMap(t.describeDynamic!(a, 'library'), 0x20000), target = textMap(t.describeDynamic!(b, 'library'), 0x30000);
    const map = (q: typeof m, fd: number) => syscall(p, 9, q.addr, q.length, 5, 0x12, fd, q.offset);
    const calls: [bigint, bigint][] = [], functions: bigint[] = [];
    const tracked = {...compiler, more(...params: Parameters<typeof compiler.more>) {
      functions.push(params[2]);
      return compiler.more(...params);
    }};
    const dispatcher = new MappedDispatcher(code, tracked, {
      syscall: (nr: bigint, a: bigint, b: bigint, c: bigint, d: bigint, e: bigint, f: bigint, next: bigint) => {
        assert.ok(nr === 10n || nr === 231n);
        calls.push([nr, next]);
        return p.syscall(nr, a, b, c, d, e, f, next);
      },
      trap(pc: bigint) { assert.fail(`unexpected unmapped fixture PC ${pc}`); },
      div128() { assert.fail('unused div128'); }, fpu() { assert.fail('unused fpu'); },
      clock: () => 0n, time: () => NaN, trace() {},
    });
    try {
      assert.equal(map(m, open('/one.so')), BigInt(m.addr));
      assert.equal(map(target, open('/two.so')), BigInt(target.addr));
      assert.equal(syscall(p, 9, 0x40000, PAGE, 3, 0x32, -1, 0), 0x40000n);
      dispatcher.setReg('r4', 0x41000n);
      dispatcher.setReg('r7', BigInt(target.addr));
      dispatcher.setReg('r6', BigInt(target.length));
      dispatcher.setReg('r2', 1n);
      assert.throws(() => dispatcher.run(BigInt(m.pc)), e => e instanceof Exit && e.status === 42 << 8);
      assert.deepEqual(calls.map(([n]) => n), [10n, 231n], 'mprotect completed once and the guest finished through exit_group');
      assert.deepEqual(functions, [BigInt(m.pc)], 'live code already contains the syscall continuation');
      assert.equal(code.find(BigInt(target.pc), code.generation), undefined);
      assert.equal(p.exitStatus, 42 << 8);
      assert.equal(p.memory, null);
      assert.equal(code.find(BigInt(m.pc), code.generation), undefined, 'exit retires all the map owner\'s code');
    } finally { dispatcher.close(); clean(); }
  } finally { rmSync(scratch, {recursive: true, force: true}); }
});

test('mapped scalar, stack and SIMD accesses use the VM authority before touching data', {skip}, async (test) => {
  const vfs = new Vfs(), t = await loadTranslator(readFileSync(wasm!)), compiler = t.mapped!;
  const scratch = mkdtempSync(join(tmpdir(), 'sods-checked-data-'));
  try {
    const src = fileURLToPath(new URL('../fixtures/mapped-code/data.S', import.meta.url)), dst = join(scratch, 'data.so');
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'cc', ['-nostdlib', '-shared', '-fPIC', '-s',
      '-Wl,-e,data,--build-id=none', src, '-o', dst], {timeout: 6_000});
    const binary = new Uint8Array(readFileSync(dst)), f = fixture(vfs, '/data.so', binary, () => binary.slice(), 'owned');
    const coldBytes = new Uint8Array(2 * PAGE).fill(17);
    const coldFile = fixture(vfs, '/constants.so', coldBytes, () => coldBytes.slice(), 'owned');
    const {p, code, user, open, clean} = processWithVm(vfs, {sources: [f.source, coldFile.source], translate: t});
    const {addr, length, offset, pc} = textMap(t.describeDynamic!(binary, 'library'), 0x30000);
    const source = BASE + PAGE - 24, dest = 0x20000 + PAGE - 24, stack = 0x40000;
    const payload = Uint8Array.from({length: 32}, (_, i) => i + 1), results: bigint[] = [];
    let hostSpans = 0;
    const observed = {memory: code.memory, accessPages: code.accessPages, get generation() { return code.generation; }, find: code.find, string: code.string,
      beginRead(a: bigint, n: bigint) { hostSpans++; return code.beginRead(a, n); },
      beginWrite(a: bigint, n: bigint) { hostSpans++; return code.beginWrite(a, n); },
      permits(a: bigint, n: bigint, access: 'read' | 'write') {
        if (n) hostSpans++;
        return code.permits(a, n, access);
      }};
    const done = new Error('Completed CPU fixture');
    const imports = {
      syscall(nr: bigint, value: bigint) { assert.equal(nr, 231n); results.push(value); throw done; },
      trap() { assert.fail('the data fixture has no instruction trap'); },
      div128() { assert.fail('unused div128'); }, fpu() { assert.fail('unused fpu'); },
      clock: () => 0n, time: () => NaN, trace() {},
    };
    assert.throws(() => new MappedDispatcher(observed, compiler, {...imports, mapped_access() {}}), /own VM authority/);
    const previous = (bytes: Uint8Array<ArrayBuffer>, marker: string): Uint8Array<ArrayBuffer> => {
      const output = bytes.slice(), at = Buffer.from(output).indexOf(marker);
      assert.ok(at >= 0);
      const version = String(MAPPED_ABI_VERSION - 1), current = String(MAPPED_ABI_VERSION);
      assert.equal(version.length, current.length);
      output.set(encode.encode(version), at + marker.length - current.length);
      return output;
    };
    assert.throws(() => new MappedDispatcher(observed,
      {...compiler, core: () => previous(compiler.core(), 'sods.mapped-core-v' + MAPPED_ABI_VERSION)}, imports), /checked dispatcher/);
    const dispatcher = new MappedDispatcher(observed, compiler, imports);
    const normal = (mode: bigint, a = BigInt(source), d = BigInt(dest), rounds = 1n) => {
      dispatcher.setReg('r7', a); dispatcher.setReg('r6', d); dispatcher.setReg('r2', mode);
      dispatcher.setReg('r4', BigInt(stack + PAGE)); dispatcher.setReg('r1', rounds);
      return () => dispatcher.run(BigInt(pc));
    };
    const permission = (a: bigint, n: number, access: 'read' | 'write') =>
      (e: unknown) => e instanceof MappedDataFault && e.address === a && e.length === n && e.access === access;
    try {
      assert.equal(syscall(p, 9, addr, length, 5, 0x12, open('/data.so'), offset), BigInt(addr));
      for (const [start, size] of [[BASE, 2 * PAGE], [0x20000, 2 * PAGE], [stack, PAGE]]) {
        assert.equal(syscall(p, 9, start, size, 3, 0x32, -1, 0), BigInt(start));
      }
      user().copyOut(source, payload);
      assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 1), 0n);
      const stale = new MappedDispatcher(observed, {...compiler,
        more: (...args) => previous(compiler.more(...args), 'sods.mapped-piece-v' + MAPPED_ABI_VERSION)}, imports);
      try {
        assert.throws(() => stale.run(BigInt(pc)), /checked data ABI/);
        assert.equal(hostSpans, 0, 'an older fragment is not attached or run');
      } finally { stale.close(); }
      assert.throws(normal(0n), error => error === done);
      const expected = new Uint8Array(32);
      expected[0] = 1;
      expected.set(payload.subarray(0, 8), 8);
      expected.set(payload.subarray(16), 16);
      assert.deepEqual(user().copyIn(dest, 32), expected);
      assert.deepEqual(results, [42n]);
      assert.equal(hostSpans, 0, 'loads and stores check the published page rights in Wasm');

      // Warm loop: exact policy work, optional diagnostic throughput;
      // this is not a browser/loader performance measurement.
      assert.throws(normal(2n, BigInt(source), BigInt(dest), 1000n), error => error === done);
      const now = performance.now(), rounds = 160_000n;
      assert.throws(normal(2n, BigInt(source), BigInt(dest), rounds), error => error === done);
      const ms = performance.now() - now;
      assert.equal(hostSpans, 0, 'the hot access loop does not ask JS for each span');
      if (process.env.SODS_MEASURE_MAPPED) test.diagnostic(`checked-access loop: ${2n * rounds} decisions in ${ms.toFixed(1)} ms`);

      const cold = 0x60000, from = BigInt(cold + PAGE - 24);
      assert.equal(new Uint8Array(code.memory.buffer)[pc], 0, 'executing text does not read it into guest RAM');
      assert.equal(syscall(p, 9, cold, 2 * PAGE, 1, 0x12, open('/constants.so'), 0), BigInt(cold));
      assert.equal(syscall(p, 10, cold + PAGE, PAGE, 0), 0n);
      assert.throws(normal(1n, from), permission(from + 16n, 16, 'read'));
      assert.equal(new Uint8Array(code.memory.buffer)[cold], 0, 'a denied span commits neither page');
      assert.equal(syscall(p, 10, cold + PAGE, PAGE, 1), 0n);
      const beforeCold = hostSpans;
      assert.throws(normal(1n, from), error => error === done);
      assert.deepEqual(user().copyIn(dest + 16, 16), coldBytes.subarray(0, 16));
      assert.equal(hostSpans, beforeCold + 1, 'one slow access initializes both pages');
      assert.throws(normal(1n, from), error => error === done);
      assert.equal(hostSpans, beforeCold + 1, 'the same access now stays in Wasm');

      dispatcher.setReg('fs', BigInt(source - 8));
      assert.throws(normal(3n, 0n), error => error === done);
      assert.deepEqual(user().copyIn(dest, 8), payload.subarray(0, 8));
      assert.throws(normal(4n, BigInt(source - 8) + (1n << 32n)), error => error === done);
      assert.deepEqual(user().copyIn(dest, 8), payload.subarray(0, 8), 'explicit addr32 has its legitimate x86 width');

      const locked = 0x20000 + PAGE - 2, ones = new Uint8Array(4).fill(255);
      user().copyOut(locked, ones);
      assert.throws(normal(5n, BigInt(source), BigInt(locked)), error => error === done);
      assert.equal(results.at(-1), 42n, 'locked add leaves the normal carry and zero flags');
      assert.deepEqual(user().copyIn(locked, 4), new Uint8Array(4));

      user().copyOut(locked, Uint8Array.of(4, 0, 0, 0));
      assert.throws(normal(6n, BigInt(source), BigInt(locked)), error => error === done);
      assert.equal(results.at(-1), 42n, 'a matching compare-and-exchange keeps the accumulator');
      assert.deepEqual(user().copyIn(locked, 4), Uint8Array.of(7, 0, 0, 0));
      assert.throws(normal(6n, BigInt(source), BigInt(locked)), error => error === done);
      assert.equal(results.at(-1), 42n, 'a mismatched compare-and-exchange returns the old value');
      assert.deepEqual(user().copyIn(locked, 4), Uint8Array.of(7, 0, 0, 0));
      assert.throws(normal(7n, BigInt(source), BigInt(locked)), error => error === done);
      assert.equal(results.at(-1), 42n, 'exchange returns the old value and preserves carry');
      assert.deepEqual(user().copyIn(locked, 4), Uint8Array.of(9, 0, 0, 0));
      const xadd = locked - 2, qwordOnes = new Uint8Array(8).fill(255);
      user().copyOut(xadd, qwordOnes);
      assert.throws(normal(8n, BigInt(source), BigInt(xadd)), error => error === done);
      assert.equal(results.at(-1), 42n, 'exchange-and-add returns the old operand and produces carry and zero');
      assert.deepEqual(user().copyIn(xadd, 8), new Uint8Array(8));
      assert.throws(normal(9n, BigInt(source), BigInt(locked + 4)), error => error === done);
      assert.equal(results.at(-1), 42n, 'negative bit offsets address the preceding word and return its old bit');
      assert.deepEqual(user().copyIn(locked, 4), Uint8Array.of(0, 0, 0, 0x80));
      user().copyOut(xadd, qwordOnes);

      const snapshot = user().copyIn(dest, 32), unchangedCode = code.generation;
      assert.equal(syscall(p, 10, 0x20000 + PAGE, PAGE, 1), 0n);
      assert.equal(code.generation, unchangedCode, 'already-compiled code must observe new data permissions');
      assert.throws(normal(1n), permission(BigInt(dest + 16), 16, 'write'));
      assert.deepEqual(user().copyIn(dest, 32), snapshot, 'a refused whole vector store has no partial write');
      assert.throws(normal(5n, BigInt(source), BigInt(locked)), permission(BigInt(locked), 4, 'write'));
      assert.deepEqual(user().copyIn(locked, 4), ones, 'a refused locked add has no partial write');
      assert.throws(normal(6n, BigInt(source), BigInt(locked)), permission(BigInt(locked), 4, 'write'));
      assert.deepEqual(user().copyIn(locked, 4), ones, 'a mismatched compare-and-exchange still requires write permission');
      assert.throws(normal(7n, BigInt(source), BigInt(locked)), permission(BigInt(locked), 4, 'write'));
      assert.deepEqual(user().copyIn(locked, 4), ones, 'a refused exchange has no partial write');
      assert.throws(normal(8n, BigInt(source), BigInt(xadd)), permission(BigInt(xadd), 8, 'write'));
      assert.deepEqual(user().copyIn(xadd, 8), qwordOnes);
      assert.throws(normal(9n, BigInt(source), BigInt(locked + 4)), permission(BigInt(locked), 4, 'write'));
      assert.deepEqual(user().copyIn(locked, 4), ones);
      assert.equal(syscall(p, 10, 0x20000 + PAGE, PAGE, 0), 0n);
      assert.throws(normal(5n, BigInt(source), BigInt(locked)), permission(BigInt(locked), 4, 'read'));
      assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 0), 0n);
      assert.throws(normal(1n), permission(BigInt(source + 16), 16, 'read'));
      assert.throws(normal(0n, BigInt(source) + (1n << 32n)), permission(BigInt(source) + (1n << 32n), 8, 'read'));

      normal(10n);
      dispatcher.setReg('r4', BigInt(stack + 16));
      assert.throws(() => dispatcher.run(BigInt(pc)), permission(BigInt(stack - 8), 8, 'write'));
      const bytes = user().copyIn(stack, 16), pushed = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      assert.equal(pushed.getBigUint64(0, true), BigInt(dest));
      assert.equal(pushed.getBigUint64(8, true), BigInt(source));
      const unmapped = stack + PAGE;
      normal(11n, BigInt(unmapped));
      dispatcher.setReg('r4', BigInt(stack));
      assert.throws(() => dispatcher.run(BigInt(pc)), permission(BigInt(unmapped), 8, 'read'));
      assert.equal(syscall(p, 9, stack - PAGE, PAGE, 3, 0x32, -1, 0), BigInt(stack - PAGE));
      normal(10n);
      dispatcher.setReg('r4', BigInt(stack + 16));
      assert.throws(() => dispatcher.run(BigInt(pc)), error => error === done);
      assert.equal(dispatcher.reg('r4'), BigInt(stack + 16));
    } finally { dispatcher.close(); clean(); }
  } finally { rmSync(scratch, {recursive: true, force: true}); }
});

test('checked MOVS/STOS preserve normal string semantics and use one bounded VM transfer', {skip}, async (test) => {
  const vfs = new Vfs(), t = await loadTranslator(readFileSync(wasm!)), compiler = t.mapped!;
  const scratch = mkdtempSync(join(tmpdir(), 'sods-checked-strings-'));
  try {
    const src = fileURLToPath(new URL('../fixtures/mapped-code/strings.S', import.meta.url)), dst = join(scratch, 'strings.so');
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'cc', ['-nostdlib', '-shared', '-fPIC', '-s',
      '-Wl,-e,strings,--build-id=none', src, '-o', dst], {timeout: 6_000});
    const binary = new Uint8Array(readFileSync(dst)), f = fixture(vfs, '/strings.so', binary);
    const {p, code, user, open, clean} = processWithVm(vfs, {sources: [f.source], translate: t});
    const {addr, length, offset, pc} = textMap(t.describeDynamic!(binary, 'library'), 0x30000);
    const source = BASE + PAGE - 8, dest = 0x20000 + PAGE - 8, stack = 0x40000;
    const payload = Uint8Array.from({length: 32}, (_, i) => i + 1);
    const value = 0x1122_3344_5566_7788n, pattern = Uint8Array.of(0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11);
    let operations = 0, result: [bigint, bigint, bigint, bigint] | undefined;
    const observed = {memory: code.memory, accessPages: code.accessPages, get generation() { return code.generation; }, find: code.find, permits: code.permits,
      beginRead: code.beginRead, beginWrite: code.beginWrite,
      string(...args: Parameters<typeof code.string>) { operations++; return code.string(...args); }};
    const done = new Error('Completed string fixture');
    const imports = {
      syscall(nr: bigint, d: bigint, s: bigint, count: bigint, flags: bigint) {
        assert.equal(nr, 231n);
        result = [d, s, count, flags & 0x401n]; // Only DF and the carried flag.
        throw done;
      },
      trap() { assert.fail('the string fixture has no instruction trap'); },
      div128() { assert.fail('unused div128'); }, fpu() { assert.fail('unused fpu'); },
      clock: () => 0n, time: () => NaN, trace() {},
    };
    assert.throws(() => new MappedDispatcher(observed, compiler, {...imports, mapped_string() {}}), /own VM authority/);
    const dispatcher = new MappedDispatcher(observed, compiler, imports);
    const enter = (mode: number, d: number | bigint, s: number | bigint, count: number) => {
      dispatcher.setReg('r8', BigInt(mode));
      dispatcher.setReg('r7', BigInt(d)); dispatcher.setReg('r6', BigInt(s));
      dispatcher.setReg('r1', BigInt(count)); dispatcher.setReg('r0', value);
      dispatcher.setReg('r4', BigInt(stack + PAGE));
      result = undefined;
      return () => dispatcher.run(BigInt(pc));
    };
    const completed = (mode: number, d: number | bigint, s: number | bigint, count: number) => {
      const was = operations;
      assert.throws(enter(mode, d, s, count), e => e === done);
      assert.equal(operations, was + 1, 'one checked transfer per string instruction');
      return result;
    };
    const mapped = (start: number, size: number) => {
      assert.equal(syscall(p, 9, start, size, 3, 0x32, -1, 0), BigInt(start));
    };
    const permission = (start: number, n: number, mode: 'read' | 'write') =>
      (e: unknown) => e instanceof MappedDataFault && e.address === BigInt(start) && e.length === n && e.access === mode;
    try {
      assert.equal(syscall(p, 9, addr, length, 5, 0x12, open('/strings.so'), offset), BigInt(addr));
      mapped(BASE, 2 * PAGE); mapped(0x20000, 2 * PAGE); mapped(stack, PAGE);
      user().copyOut(source, payload);
      // A readable, differently protected second region is still part
      // of the source. The copies below all cross both page boundaries.
      assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 1), 0n);
      for (const [mode, width, back] of [[0, 1, 0], [1, 1, 1], [2, 2, 0], [3, 4, 1], [4, 8, 0]]) {
        user().copyOut(dest, new Uint8Array(32));
        const d = back ? dest + 16 - width : dest, s = back ? source + 16 - width : source;
        assert.deepEqual(completed(mode, d, s, 16 / width),
          [BigInt(d + (back ? -16 : 16)), BigInt(s + (back ? -16 : 16)), 0n, back ? 0x401n : 1n]);
        assert.deepEqual(user().copyIn(dest, 16), payload.subarray(0, 16));
      }
      for (const [mode, width, back] of [[5, 1, 0], [6, 2, 1], [7, 4, 0], [8, 8, 1]]) {
        user().copyOut(dest, new Uint8Array(32));
        const d = back ? dest + 24 - width : dest;
        assert.deepEqual(completed(mode, d, source, 24 / width),
          [BigInt(d + (back ? -24 : 24)), BigInt(source), 0n, back ? 0x401n : 1n]);
        assert.deepEqual(user().copyIn(dest, 24), Uint8Array.from({length: 24}, (_, i) => pattern[i % width]));
      }
      assert.deepEqual(completed(9, dest, source, 37), [BigInt(dest + 8), BigInt(source + 8), 37n, 1n]);
      assert.deepEqual(user().copyIn(dest, 8), payload.subarray(0, 8));
      assert.deepEqual(completed(10, dest, source, 37), [BigInt(dest - 1), BigInt(source), 37n, 0x401n]);
      assert.equal(user().copyIn(dest, 1)[0], pattern[0]);
      assert.deepEqual(completed(0, 0n, -1n, 0), [0n, -1n, 0n, 1n], 'zero repeat does not inspect either pointer');

      // Copies that feed unread source use x86 traversal, not memmove.
      user().copyOut(dest, encode.encode('ABCDEF'));
      completed(0, dest + 1, dest, 5);
      assert.equal(Buffer.from(user().copyIn(dest, 6)).toString(), 'AAAAAA');
      user().copyOut(dest, encode.encode('ABCDEF'));
      completed(1, dest + 4, dest + 5, 5);
      assert.equal(Buffer.from(user().copyIn(dest, 6)).toString(), 'FFFFFF');
      user().copyOut(dest, encode.encode('ABCDEF'));
      completed(0, dest, dest + 1, 5);
      assert.equal(Buffer.from(user().copyIn(dest, 6)).toString(), 'BCDEFF');
      user().copyOut(dest, payload.subarray(0, 10));
      completed(2, dest + 1, dest, 4);
      assert.deepEqual(user().copyIn(dest, 10), Uint8Array.of(1, 1, 2, 2, 4, 4, 6, 6, 8, 10));

      const kept = user().copyIn(dest, 32), epoch = code.generation;
      assert.equal(syscall(p, 10, 0x20000 + PAGE, PAGE, 1), 0n);
      assert.equal(code.generation, epoch, 'warm code observes current data rights');
      assert.throws(enter(0, dest, source, 16), permission(dest, 16, 'write'));
      assert.throws(enter(8, dest + 16, source, 3), permission(dest, 24, 'write'));
      assert.deepEqual(user().copyIn(dest, 32), kept, 'neither refused transfer publishes even a prefix');
      assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 0), 0n);
      assert.throws(enter(0, dest, source, 16), permission(source, 16, 'read'));
      assert.throws(enter(4, dest, source, MAPPED_STRING_LIMIT / 8 + 1), MappedStringLimit);
      assert.deepEqual(user().copyIn(dest, 32), kept);

      // Large benign contiguous transfers still cross the host once
      // apiece, rather than checking or allocating per element.
      const a = 0x80000, b = 0x200000;
      mapped(a, MAPPED_STRING_LIMIT); mapped(b, MAPPED_STRING_LIMIT);
      user().copyOut(a, Uint8Array.of(23));
      user().copyOut(a + MAPPED_STRING_LIMIT - 1, Uint8Array.of(79));
      completed(0, b, a, MAPPED_STRING_LIMIT);
      const starting = operations, now = performance.now();
      for (let i = 0; i < 32; i++) completed(0, b, a, MAPPED_STRING_LIMIT);
      const elapsed = performance.now() - now;
      assert.equal(operations - starting, 32);
      assert.equal(user().copyIn(b, 1)[0], 23);
      assert.equal(user().copyIn(b + MAPPED_STRING_LIMIT - 1, 1)[0], 79);
      if (process.env.SODS_MEASURE_MAPPED) test.diagnostic(`32 checked MiB in ${elapsed.toFixed(1)} ms (32 VM transfers)`);
    } finally { dispatcher.close(); clean(); }
  } finally { rmSync(scratch, {recursive: true, force: true}); }
});
