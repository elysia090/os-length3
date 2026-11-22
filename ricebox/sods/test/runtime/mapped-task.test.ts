import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {captureExecutableSource} from '../../runtime/linux.ts';
import {Description} from '../../runtime/linux/fd.ts';
import {E, FsError, mountTarget, Vfs} from '../../runtime/linux/fs.ts';
import {MappedVm} from '../../runtime/linux/mapped-vm.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {RET} from '../../runtime/linux/seccomp.ts';
import {loadTranslator} from '../../runtime/translate.ts';
import type {MappedTranslate} from '../../runtime/translation/mapped.ts';
import type {Translate} from '../../runtime/translation/translator.ts';

const wasm = process.env.SODS_TEST_MAPPED_WASM;
const skip = !wasm ? 'requires a translator built with mapped-code' : false;
const path = '/scheduler.so', PAGE = 4096, BASE = 0x10000, data = 0x12000, sp = 0x14000, bias = 0x20000;
const consoleOut = {read: () => null, write(_fd: number, _data: Uint8Array) {}};
const syscall = (p: Process, nr: number, args: number[]): bigint => p.syscall(BigInt(nr),
  ...[...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]);

function fixture(vfs: Vfs) {
  const dir = mkdtempSync(join(tmpdir(), 'sods-task-'));
  let bytes: Uint8Array;
  try {
    const src = fileURLToPath(new URL('../fixtures/mapped-code/scheduler.S', import.meta.url)), out = join(dir, 'guest.so');
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'cc',
      ['-nostdlib', '-shared', '-fPIC', '-s', '-Wl,-e,scheduler,--build-id=none', src, '-o', out], {timeout: 6_000});
    bytes = new Uint8Array(readFileSync(out));
  } finally { rmSync(dir, {recursive: true, force: true}); }
  const origin = createHash('sha256').update(bytes).digest('hex');
  const file = mountTarget(vfs).file(path, 0o555, bytes.length, () => bytes, origin);
  const source = captureExecutableSource(vfs, path, {origin, size: bytes.length});
  return {file, source, bytes};
}

function mappedTask(kernel: Kernel, t: Translate, compiler: MappedTranslate, f: ReturnType<typeof fixture>, peer = false) {
  const p = new Process(kernel, null);
  p.noNewPrivs = true;
  p.argv = [path]; p.env = [];
  p.mapBase = p.mapEnd = BASE;
  p.stackLow = sp - PAGE; p.stackTop = sp;
  p.free = []; p.fixed = [];
  const reader = {describeDynamic: t.describeDynamic!, notProgram: t.notProgram};
  const memory = p.memory = MappedVm.allocate({vfs: kernel.vfs, base: BASE, pages: 1, sources: [f.source], reader});
  const vm = memory.mappedVm;
  assert.equal(syscall(p, 9, [data, 2 * PAGE, 3, 0x32, -1, 0]), BigInt(data));
  vm.userMemory(p).copyOut(data, new TextEncoder().encode('mapped\n'));
  const stdout = new Description('console', {flags: 1, path: 'stdout'});
  p.fds.install(stdout, {fd: 1});
  const fd = p.fds.install(new Description('file', {node: f.file, mnt: p.root.mnt, flags: 0, path}));
  const text = reader.describeDynamic(f.bytes, 'library').loads.find(s => s.flags === 5)!;
  assert.ok(text);
  const start = Math.floor(text.vaddr / PAGE) * PAGE + bias;
  const length = Math.ceil((text.vaddr + text.fileSize) / PAGE) * PAGE + bias - start;
  assert.equal(syscall(p, 9, [start, length, 5, 0x12, fd, Math.floor(text.offset / PAGE) * PAGE]), BigInt(start));
  const pc = BigInt(bias) + new DataView(f.bytes.buffer).getBigUint64(24, true);
  const task = kernel.newTask(p);
  p.pid = p.pgid = p.sid = task.tid;
  p.tasks.add(task);
  p.task = task;
  assert.throws(() => task.prepareMapped(compiler, pc, BigInt(sp - 1)), e => e instanceof FsError && e.errno === E.FAULT);
  task.prepareMapped(compiler, pc, BigInt(sp));
  task.setReg(6, data);
  task.setReg(7, peer ? 1 : 0);
  assert.equal(kernel.tasks.has(task.tid), false, 'preparation did not publish a Task');
  // Trusted test owner, not a launcher or a way to admit exec.
  kernel.tasks.set(task.tid, task);
  kernel.procs.set(p.pid, p);
  return {p, task, vm, memory, pc, stdout};
}

test('the normal inline scheduler preempts, waits and resumes a mapped task, then retires after syscall unwind', {skip}, async () => {
  const t = await loadTranslator(readFileSync(wasm!)), compiler = t.mapped!, vfs = new Vfs();
  const f = fixture(vfs), writes: string[] = [], calls: [number, number][] = [];
  let full = true, fullChecks = 0, flushes = 0, inExitImport = false, stops = 0;
  const k = new Kernel({vfs, translate: t, console: {...consoleOut,
    full() {
      fullChecks++;
      assert.throws(() => k.pump(), /mapped scheduler cannot reenter/);
      return full;
    },
    write(fd, bytes) { assert.equal(fd, 1); writes.push(Buffer.from(bytes).toString()); },
    flush() { flushes++; },
  }});
  const released = new Map<number, number>();
  const tracked = (id: number): MappedTranslate => ({...compiler, close(known) {
    assert.equal(inExitImport, false, 'reclaim code only after Wasm and its syscall import unwound');
    assert.equal(k.status, null, 'no init status before the compiler releases ownership');
    released.set(id, (released.get(id) ?? 0) + 1);
    compiler.close(known);
  }});
  const first = mappedTask(k, t, tracked(1), f), peer = mappedTask(k, t, tracked(2), f, true);
  const observed = new Map([[first.p, first], [peer.p, peer]]);
  const attempt = k.attempt.bind(k);
  k.attempt = (who, call) => {
    calls.push([who.tid, call.nr]);
    if (call.nr !== 231) return attempt(who, call);
    const owner = observed.get(who.proc)!;
    inExitImport = true;
    try { return attempt(who, call); }
    finally {
      assert.equal(who.proc.state, 'live', 'only request exit while the import is active');
      assert.equal(k.status, null);
      assert.equal(owner.stdout.closed, false);
      assert.equal(owner.vm.code.find(owner.pc, owner.vm.code.generation), undefined, 'revoke before unwind');
      assert.equal(owner.vm.code.permits(BigInt(data), 1n, 'read'), false);
      inExitImport = false;
    }
  };
  k.stopped = () => { stops++; assert.equal(released.get(1), 1); assert.equal(first.memory.users, 0); };
  try {
    assert.throws(() => first.task.bytes, /checked kernel copy/);
    first.task.slice = 1;
    k.ready(first.task); k.ready(peer.task);
    assert.equal(k.runq.shift(), first.task);
    k.run(first.task);
    assert.deepEqual(k.runq, [peer.task, first.task], 'slice expiry gives the ready peer its turn');
    assert.equal(flushes, 1);
    assert.equal(calls.length, 0, 'bounded computation preempted before its first syscall');
    assert.deepEqual(k.pump(), {waiting: true});
    assert.equal(peer.p.exitStatus, 17 << 8);
    assert.equal(first.task.state, 'blocked');
    assert.deepEqual([...k.blocked], [first.task]);
    assert.equal(first.task.call?.nr, 1);
    assert.ok(fullChecks > 0);
    assert.equal(writes.length, 0, 'waiting write had no output effect');
    full = false;
    assert.deepEqual(k.pump(), {status: 42 << 8}, 'guest checks flags, RAX and RCX after the blocked write');
    assert.equal(calls.filter(([, nr]) => nr === 231).length, 2);
    assert.deepEqual(writes, ['mapped\n']);
    assert.equal(stops, 1);
    assert.deepEqual([...released.entries()], [[2, 1], [1, 1]]);
    assert.deepEqual([k.procs.size, k.tasks.size, k.blocked.size, k.runq.length], [0, 0, 0, 0]);
    assert.equal(k.current, null);
    for (const owner of [first, peer]) {
      assert.equal(owner.p.memory, null);
      assert.equal(owner.stdout.closed, true);
      assert.equal(owner.memory.users, 0);
      assert.equal(k.spareMemories.includes(owner.memory), false);
    }
  } finally { k.halt(); }
});

test('mapped system calls retain the Task filter', {skip}, async () => {
  const t = await loadTranslator(readFileSync(wasm!)), vfs = new Vfs(), f = fixture(vfs);
  const k = new Kernel({vfs, translate: t, console: {...consoleOut, write() { assert.fail('screened write'); }}});
  const owner = mappedTask(k, t, t.mapped!, f);
  // BPF loads seccomp_data.nr, returns EACCES for write, permits exit.
  owner.task.screen([{code: Uint16Array.of(0x20, 0x15, 0x06, 0x06), jt: Uint8Array.of(0, 0, 0, 0),
    jf: Uint8Array.of(0, 1, 0, 0), k: Uint32Array.of(0, 1, RET.ERRNO | E.ACCES, RET.ALLOW)}]);
  try {
    k.ready(owner.task);
    assert.deepEqual(k.pump(), {status: 2 << 8}, 'the fixture observed a normal syscall refusal');
    assert.equal(owner.p.call, null);
  } finally { k.halt(); }
});

test('an unconfirmed mapped compiler retirement retains its owners and never publishes exit', {skip}, async () => {
  const t = await loadTranslator(readFileSync(wasm!)), compiler = t.mapped!, vfs = new Vfs();
  const f = fixture(vfs), k = new Kernel({vfs, translate: t, console: consoleOut});
  const unavailable = new Error('Compiler cleanup unavailable');
  let requested = 0, stopped = 0;
  const owner = mappedTask(k, t, {...compiler, close() { requested++; throw unavailable; }}, f, true);
  k.stopped = () => { stopped++; };
  k.ready(owner.task);
  let failure: unknown;
  assert.throws(() => k.pump(), error => {
    failure = error;
    return error instanceof Error && error.name === 'MappedTaskOwnershipError' &&
      error.cause instanceof AggregateError && error.cause.errors[0] === unavailable;
  });
  assert.equal(k.status, null);
  assert.equal(k.current, null);
  assert.equal(stopped, 0);
  assert.equal(k.tasks.get(owner.task.tid), owner.task);
  assert.equal(owner.p.memory, owner.memory);
  assert.equal(owner.memory.users, 1);
  assert.equal(owner.stdout.closed, false);
  assert.equal(owner.vm.code.find(owner.pc, owner.vm.code.generation), undefined);
  assert.equal(owner.vm.code.permits(BigInt(data), 1n, 'read'), false);
  for (const doIt of [() => k.pump(), () => k.halt(), () => k.ended(), () => k.free()]) assert.throws(doIt, e => e === failure);
  assert.equal(k.retireInitialMounts(), false);
  assert.equal(requested, 1, 'uncertain retirement is never retried');
  assert.throws(() => new Kernel({vfs, console: consoleOut}), /unresolved transaction/);
});
