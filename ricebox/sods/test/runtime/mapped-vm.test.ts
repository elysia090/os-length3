import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {MappedCodeChanged} from '../../runtime/linux/exec/mapped-code-space.ts';
import {MappedDispatcher} from '../../runtime/linux/exec/mapped-dispatcher.ts';
import {Description} from '../../runtime/linux/fd.ts';
import type {ExecutableSource} from '../../runtime/linux/executable-source.ts';
import {Exit} from '../../runtime/linux/flow.ts';
import {E, FsError, MNT, mountTarget, Vfs} from '../../runtime/linux/fs.ts';
import {MAPPED_COPY_LIMIT, newMappedMemory} from '../../runtime/linux/mapped-vm.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {ReadLifetimeError} from '../../runtime/linux/read-lifetime.ts';
import {captureExecutableSource} from '../../runtime/linux.ts';
import {loadTranslator} from '../../runtime/translate.ts';
import type {ElfLoadSpec} from '../../runtime/translation/dynamic-load.ts';
import type {Translate} from '../../runtime/translation/translator.ts';

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

function fixture(vfs: Vfs, path: string, bytes: Uint8Array, loader = () => bytes) {
  const origin = createHash('sha256').update(bytes).digest('hex');
  const file = mountTarget(vfs).file(path, 0o644, bytes.length, loader, origin);
  return {file, source: captureExecutableSource(vfs, path, {origin, size: bytes.length})};
}

function processWithVm(vfs = new Vfs(), {sources = [], translate, write = consoleOut.write}: {
  sources?: ExecutableSource[]; translate?: Translate; write?(fd: number, bytes: Uint8Array): void;
} = {}) {
  const kernel = new Kernel({vfs, translate, console: {...consoleOut, write}}), p = new Process(kernel, null);
  p.mapBase = p.mapEnd = p.stackTop = BASE;
  p.stackLow = 4096;
  p.free = []; p.fixed = [];
  p.noNewPrivs = true;
  const reader = translate ? {describeDynamic: translate.describeDynamic!, notProgram: translate.notProgram} : neverDescribe;
  const memory = p.memory = newMappedMemory({vfs, base: BASE, pages: 1, sources, reader}), vm = memory.mappedVm;
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
    assert.equal(syscall(p, 318, BASE, 1), err(E.NOSYS), 'an unported buffer syscall is not a fallback');
    assert.equal(p.call, null);
    assert.equal(p.fds.get(output)?.offset, 7);
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
  const {kernel, p, user, open, code, clean} = processWithVm(vfs, {sources: [a.source, b.source, invalid.source], translate: t});
  try {
    const m = textMap(t.describeDynamic!(bytes, 'library'), 0x20000);
    const load = (fd: number) => syscall(p, 9, m.addr, m.length, 5, 0x812, fd, m.offset);
    const fd = open(lib);
    assert.equal(load(fd), BigInt(m.addr));
    const epoch = code.generation, bound = code.find(BigInt(m.pc), epoch);
    assert.ok(bound);
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

test('one real mprotect invalidates old Wasm, restores RAX, RCX and flags, and returns to guest exactly once', {skip}, async () => {
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
      assert.equal(functions[0], BigInt(m.pc));
      assert.equal(functions[1], calls[0][1], 'new Wasm starts at the retired call frame\'s next PC');
      assert.equal(code.find(BigInt(target.pc), code.generation), undefined);
      assert.equal(p.exitStatus, 42 << 8);
      assert.equal(p.memory, null);
      assert.equal(code.find(BigInt(m.pc), code.generation), undefined, 'exit retires all the map owner\'s code');
    } finally { dispatcher.close(); clean(); }
  } finally { rmSync(scratch, {recursive: true, force: true}); }
});
