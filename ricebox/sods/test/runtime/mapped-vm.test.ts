import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {MappedCodeChanged} from '../../runtime/linux/exec/mapped-code-space.ts';
import {MappedDataFault, MappedDispatcher} from '../../runtime/linux/exec/mapped-dispatcher.ts';
import {Description} from '../../runtime/linux/fd.ts';
import type {ExecutableSource} from '../../runtime/linux/executable-source.ts';
import {Exit} from '../../runtime/linux/flow.ts';
import {E, FsError, MNT, mountTarget, Vfs} from '../../runtime/linux/fs.ts';
import {MAPPED_COPY_LIMIT, MAPPED_STRING_LIMIT, MappedStringLimit, newMappedMemory} from '../../runtime/linux/mapped-vm.ts';
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

test('mapped scalar, stack and SIMD accesses use the VM authority before touching data', {skip}, async (test) => {
  const vfs = new Vfs(), t = await loadTranslator(readFileSync(wasm!)), compiler = t.mapped!;
  const scratch = mkdtempSync(join(tmpdir(), 'sods-checked-data-'));
  try {
    const src = fileURLToPath(new URL('../fixtures/mapped-code/data.S', import.meta.url)), dst = join(scratch, 'data.so');
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'cc', ['-nostdlib', '-shared', '-fPIC', '-s',
      '-Wl,-e,data,--build-id=none', src, '-o', dst], {timeout: 6_000});
    const binary = new Uint8Array(readFileSync(dst)), f = fixture(vfs, '/data.so', binary);
    const {p, code, user, open, clean} = processWithVm(vfs, {sources: [f.source], translate: t});
    const {addr, length, offset, pc} = textMap(t.describeDynamic!(binary, 'library'), 0x30000);
    const source = BASE + PAGE - 24, dest = 0x20000 + PAGE - 24, stack = 0x40000;
    const payload = Uint8Array.from({length: 32}, (_, i) => i + 1), results: bigint[] = [];
    let reads = 0, writes = 0;
    const observed = {memory: code.memory, get generation() { return code.generation; }, find: code.find, string: code.string,
      permits(a: bigint, n: bigint, access: 'read' | 'write') {
        if (access === 'read') reads++; else writes++;
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
      output[at + marker.length - 1] = '3'.charCodeAt(0);
      return output;
    };
    assert.throws(() => new MappedDispatcher(observed,
      {...compiler, core: () => previous(compiler.core(), 'sods.mapped-core-v4')}, imports), /checked dispatcher/);
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
        more: (...args) => previous(compiler.more(...args), 'sods.mapped-piece-v4')}, imports);
      try {
        assert.throws(() => stale.run(BigInt(pc)), /checked data ABI/);
        assert.deepEqual([reads, writes], [0, 0], 'an older fragment is not attached or run');
      } finally { stale.close(); }
      assert.throws(normal(0n), error => error === done);
      const expected = new Uint8Array(32);
      expected[0] = 1;
      expected.set(payload.subarray(0, 8), 8);
      expected.set(payload.subarray(16), 16);
      assert.deepEqual(user().copyIn(dest, 32), expected);
      assert.deepEqual(results, [42n]);
      assert.deepEqual([reads, writes], [5, 5], 'each emitted load and store takes one whole-span decision');

      // Warm loop: exact policy work, optional diagnostic throughput;
      // this is not a browser/loader performance measurement.
      assert.throws(normal(2n, BigInt(source), BigInt(dest), 1000n), error => error === done);
      const before = [reads, writes], now = performance.now(), rounds = 160_000n;
      assert.throws(normal(2n, BigInt(source), BigInt(dest), rounds), error => error === done);
      const ms = performance.now() - now;
      assert.deepEqual([reads - before[0], writes - before[1]], [Number(rounds), Number(rounds)]);
      if (process.env.SODS_MEASURE_MAPPED) test.diagnostic(`checked-access loop: ${reads + writes - before[0] - before[1]} decisions in ${ms.toFixed(1)} ms`);

      dispatcher.setReg('fs', BigInt(source - 8));
      assert.throws(normal(3n, 0n), error => error === done);
      assert.deepEqual(user().copyIn(dest, 8), payload.subarray(0, 8));
      assert.throws(normal(4n, BigInt(source - 8) + (1n << 32n)), error => error === done);
      assert.deepEqual(user().copyIn(dest, 8), payload.subarray(0, 8), 'explicit addr32 has its legitimate x86 width');

      const snapshot = user().copyIn(dest, 32), unchangedCode = code.generation;
      assert.equal(syscall(p, 10, 0x20000 + PAGE, PAGE, 1), 0n);
      assert.equal(code.generation, unchangedCode, 'already-compiled code must observe new data permissions');
      assert.throws(normal(1n), permission(BigInt(dest + 16), 16, 'write'));
      assert.deepEqual(user().copyIn(dest, 32), snapshot, 'a refused whole vector store has no partial write');
      assert.equal(syscall(p, 10, BASE + PAGE, PAGE, 0), 0n);
      assert.throws(normal(1n), permission(BigInt(source + 16), 16, 'read'));
      assert.throws(normal(0n, BigInt(source) + (1n << 32n)), permission(BigInt(source) + (1n << 32n), 8, 'read'));
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
    const observed = {memory: code.memory, get generation() { return code.generation; }, find: code.find, permits: code.permits,
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
