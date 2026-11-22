import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {captureExecutableSource} from '../../runtime/linux.ts';
import {ExecPreparationChangedError} from '../../runtime/linux/exec/source.ts';
import {Description} from '../../runtime/linux/fd.ts';
import {E, FsError, mountTarget, Vfs} from '../../runtime/linux/fs.ts';
import {captureMappedLibraries} from '../../runtime/linux/mapped-libraries.ts';
import {MappedVm} from '../../runtime/linux/mapped-vm.ts';
import {Kernel, Process} from '../../runtime/linux/process.ts';
import {RET} from '../../runtime/linux/seccomp.ts';
import {loadTranslator} from '../../runtime/translate.ts';
import type {MappedTranslate} from '../../runtime/translation/mapped.ts';
import type {Translate} from '../../runtime/translation/translator.ts';

const wasm = process.env.SODS_TEST_MAPPED_WASM;
const skip = !wasm ? 'requires a translator built with mapped-code' : false;
const PAGE = 4096, BASE = 0x10000, data = 0x12000, sp = 0x14000, bias = 0x20000;
const consoleOut = {read: () => null, write(_fd: number, _data: Uint8Array) {}};
const syscall = (p: Process, nr: number, args: number[]): bigint => p.syscall(BigInt(nr),
  ...[...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]);

function fixture(vfs: Vfs, name: 'scheduler' | 'tls' | 'tid' = 'scheduler') {
  const dir = mkdtempSync(join(tmpdir(), 'sods-task-'));
  let bytes: Uint8Array;
  try {
    const src = fileURLToPath(new URL(`../fixtures/mapped-code/${name}.S`, import.meta.url)), out = join(dir, 'guest.so');
    execFileSync(process.env.SODS_FIXTURE_CC ?? 'cc',
      ['-nostdlib', '-shared', '-fPIC', '-s', `-Wl,-e,${name},--build-id=none`, src, '-o', out], {timeout: 6_000});
    bytes = new Uint8Array(readFileSync(out));
  } finally { rmSync(dir, {recursive: true, force: true}); }
  const origin = createHash('sha256').update(bytes).digest('hex');
  const path = `/${name}.so`;
  const file = mountTarget(vfs).file(path, 0o555, bytes.length, () => bytes, origin);
  const source = captureExecutableSource(vfs, path, {origin, size: bytes.length});
  return {file, source, bytes, path};
}

function mappedTask(kernel: Kernel, t: Translate, compiler: MappedTranslate, f: ReturnType<typeof fixture>,
    {peer = false, initial = false} = {}) {
  const p = new Process(kernel, null, false, false, null, null, !initial);
  p.noNewPrivs = true;
  p.argv = [f.path]; p.env = [];
  p.mapBase = p.mapEnd = BASE;
  p.stackLow = sp - PAGE; p.stackTop = sp;
  p.free = []; p.fixed = [];
  const reader = {describeDynamic: t.describeDynamic!, notProgram: t.notProgram};
  const libraries = captureMappedLibraries(kernel.vfs, [f.source]);
  const memory = p.memory = MappedVm.allocate({vfs: kernel.vfs, base: BASE, pages: 1, libraries, reader});
  const vm = memory.mappedVm;
  assert.equal(syscall(p, 9, [data, 2 * PAGE, 3, 0x32, -1, 0]), BigInt(data));
  vm.userMemory(p).copyOut(data, new TextEncoder().encode('mapped\n'));
  const stdout = new Description('console', {flags: 1, path: 'stdout'});
  p.fds.install(stdout, {fd: 1});
  const fd = p.fds.install(new Description('file', {node: f.file, mnt: p.root.mnt, flags: 0, path: f.path}));
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
  const publishInitial = task.prepareMapped(compiler, pc, BigInt(sp));
  task.setReg(6, data);
  task.setReg(7, peer ? 1 : 0);
  assert.equal(kernel.tasks.has(task.tid), false, 'preparation did not publish a Task');
  if (!initial) {
    // Trusted arena fixtures exercise the scheduler independently of start.
    kernel.tasks.set(task.tid, task);
    kernel.procs.set(p.pid, p);
  }
  return {p, task, vm, memory, pc, stdout, publishInitial};
}

test('one checked interpreter-free initial Task uses ordinary publication, run and exit', {skip}, async () => {
  const t = await loadTranslator(readFileSync(wasm!)), compiler = t.mapped!, vfs = new Vfs(), output: string[] = [];
  let full = true, checks = 0;
  const fixtureFile = fixture(vfs), k = new Kernel({vfs, translate: t,
    console: {...consoleOut, full: () => { checks++; return full; }, write(_fd, bytes) { output.push(Buffer.from(bytes).toString()); }}});
  const owner = mappedTask(k, t, compiler, fixtureFile, {initial: true}), {p, task, vm, memory, stdout} = owner;
  const generation = vm.code.generation, more = compiler.more;
  let compiled = 0, stopped = 0;
  compiler.more = (...args) => {
    if (compiled++ === 0) {
      assert.equal(k.current, task);
      assert.equal(vm.code.generation, generation);
      assert.equal(vm.code.find(owner.pc, generation)?.text.role, 'library');
    }
    return more(...args);
  };
  k.stopped = () => { stopped++; assert.equal(memory.users, 0); assert.equal(stdout.closed, true); };
  try {
    assert.deepEqual([k.procs.size, k.tasks.size, k.runq.length, p.cgroup.procs.size, k.status], [0, 0, 0, 0, null]);
    assert.deepEqual(k.tty, {sid: 0, fg: 0});
    owner.publishInitial();
    assert.equal(k.initOf(), p);
    assert.equal(task.tid, p.pid);
    assert.equal(k.tasks.get(task.tid), task);
    assert.equal(p.cgroup.procs.has(p), true);
    assert.deepEqual(k.tty, {sid: p.sid, fg: p.pgid});
    assert.equal(task.state, 'ready');
    assert.equal(compiled, 0, 'publication does not execute or compile guest code');
    assert.throws(() => owner.publishInitial(), ExecPreparationChangedError);
    assert.throws(() => syscall(p, 1, [1, data, 7]), /Mapped syscall requires a confirmed first entry/);
    assert.equal(p.call, null);
    assert.equal(checks, 0, 'the pending entry did not reach the console');
    assert.deepEqual(output, []);
    assert.deepEqual(k.runq, [task]);
    assert.deepEqual(k.pump(), {waiting: true});
    assert.equal(task.call?.nr, 1, 'the first guest call may wait normally');
    assert.deepEqual(output, []);
    full = false;
    assert.deepEqual(k.pump(), {status: 42 << 8});
    assert.ok(compiled > 0);
    assert.deepEqual(output, ['mapped\n']);
    assert.equal(stopped, 1);
    assert.deepEqual([k.procs.size, k.tasks.size, k.runq.length, p.cgroup.procs.size], [0, 0, 0, 0]);
    assert.equal(k.spareMemories.includes(memory), false);
  } finally { compiler.more = more; k.halt(); }
});

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
  const first = mappedTask(k, t, tracked(1), f), peer = mappedTask(k, t, tracked(2), f, {peer: true});
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

test('mapped arch_prctl completes FS once after unwind and checked TLS survives a scheduler wait', {skip}, async () => {
  const t = await loadTranslator(readFileSync(wasm!)), compiler = t.mapped!, vfs = new Vfs(), f = fixture(vfs, 'tls');
  const output: string[] = [], calls: [bigint, bigint][] = [];
  let full = true, closed = 0;
  const k = new Kernel({vfs, translate: t, console: {...consoleOut,
    full: () => full, write(_fd, text) { output.push(Buffer.from(text).toString()); },
  }});
  const owner = mappedTask(k, t, {...compiler, close(known) { closed++; compiler.close(known); }}, f);
  const cross = 0x16000 - 4;
  assert.equal(syscall(owner.p, 9, [0x15000, 2 * PAGE, 3, 0x32, -1, 0]), 0x15000n);
  let user = owner.vm.userMemory(owner.p);
  user.copyOut(cross, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
  user.copyOut(data + 16, Uint8Array.of(0x40, 0x30, 0x20, 0x10));
  assert.equal(syscall(owner.p, 10, [0x16000, PAGE, 1]), 0n);
  user = owner.vm.userMemory(owner.p);
  owner.task.setReg(13, cross);
  const generation = owner.vm.code.generation, attempt = k.attempt.bind(k);
  k.attempt = (who, call) => {
    if (call.nr !== 158) return attempt(who, call);
    const before = owner.task.reg(16), result = attempt(who, call);
    assert.equal(owner.task.reg(16), before, 'the syscall did not edit an active Wasm frame');
    assert.equal(owner.vm.code.generation, generation, 'a base-register change is not an executable map change');
    assert.equal(typeof result, 'bigint');
    calls.push([call.args[0], result as bigint]);
    return result;
  };
  try {
    assert.equal(syscall(owner.p, 158, [0x1002, data + 16]), BigInt(-E.NOSYS), 'no detached or direct syscall context for FS');
    calls.length = 0;
    k.ready(owner.task);
    assert.deepEqual(k.pump(), {waiting: true});
    assert.equal(owner.task.call?.nr, 1);
    assert.equal(owner.task.reg(16), BigInt(data + 16));
    assert.equal(new DataView(user.copyIn(data + 32, 8).buffer).getBigUint64(0, true), BigInt(data + 16));
    assert.equal(new DataView(user.copyIn(data + 20, 4).buffer).getUint32(0, true), 0x556677);
    assert.deepEqual(user.copyIn(cross, 8), Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
    assert.equal(closed, 0);
    assert.equal(output.length, 0);
    assert.deepEqual(calls.slice(), [[0x1002n, 0n], [0x1003n, 0n], [0x1003n, BigInt(-E.FAULT)]]);
    full = false;
    assert.deepEqual(k.pump(), {status: 42 << 8});
    assert.deepEqual(calls.slice(3), [[0x1002n, 0n], [0x1003n, 0n]]);
    assert.deepEqual(output, ['mapped\n']);
    assert.equal(owner.task.reg(16), 0n);
    assert.equal(closed, 1, 'both SETs reused the same code generation until exit');
  } finally { k.halt(); }
});

test('seccomp refusal never completes a mapped FS-base change', {skip}, async () => {
  const t = await loadTranslator(readFileSync(wasm!)), vfs = new Vfs(), f = fixture(vfs, 'tls');
  const k = new Kernel({vfs, translate: t, console: {...consoleOut, write() { assert.fail('FS SET should be refused'); }}});
  const owner = mappedTask(k, t, t.mapped!, f);
  owner.task.screen([{code: Uint16Array.of(0x20, 0x15, 0x06, 0x06), jt: Uint8Array.of(0, 0, 0, 0),
    jf: Uint8Array.of(0, 1, 0, 0), k: Uint32Array.of(0, 158, RET.ERRNO | E.ACCES, RET.ALLOW)}]);
  try {
    k.ready(owner.task);
    assert.deepEqual(k.pump(), {status: 2 << 8}, 'the fixture reported the denied SET and made no TLS access');
    assert.equal(owner.task.reg(16), 0n);
    assert.equal(owner.p.call, null);
  } finally { k.halt(); }
});

for (const mode of ['clear', 'cancel', 'read-only'] as const) {
  test(`mapped clear-tid at normal exit respects its last registration: ${mode}`, {skip}, async () => {
    const t = await loadTranslator(readFileSync(wasm!)), compiler = t.mapped!, vfs = new Vfs(), f = fixture(vfs, 'tid');
    const first = data + 16, last = data + 20, words = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
    const output: string[] = [], calls: [bigint, bigint][] = [];
    let full = true, inExitImport = false, retired = 0, reported = 0, afterRelease = () => {};
    const k = new Kernel({vfs, translate: t, console: {...consoleOut,
      full: () => full, write(_fd, text) { output.push(Buffer.from(text).toString()); },
    }});
    const owner = mappedTask(k, t, {...compiler, close(known) {
      assert.equal(inExitImport, false);
      assert.equal(k.status, null);
      compiler.close(known);
      afterRelease();
      retired++;
    }}, f);
    owner.vm.userMemory(owner.p).copyOut(first, words);
    owner.task.setReg(13, mode === 'cancel' ? 0 : last);
    const snapshot = () => new Uint8Array(owner.memory.buffer, first, 8).slice(); // Host-side retirement evidence only.
    afterRelease = () => {
      assert.equal(k.tasks.get(owner.task.tid), owner.task, 'the scheduler still owns this Task during backend release');
      assert.deepEqual(snapshot(), words, 'clear still pending during compiler release');
    };
    k.stopped = () => {
      reported++;
      assert.equal(retired, 1);
      assert.deepEqual(snapshot(), mode === 'clear' ? Uint8Array.of(1, 2, 3, 4, 0, 0, 0, 0) : words,
        'exit observers see only the permitted clear after backend retirement');
    };
    let rawViews = 0;
    Object.defineProperty(owner.p, 'view', {get() { rawViews++; throw new Error('mapped exits must not use the static view'); }});
    const attempt = k.attempt.bind(k);
    k.attempt = (who, call) => {
      if (call.nr === 218) {
        const result = attempt(who, call);
        assert.equal(typeof result, 'bigint');
        calls.push([call.args[0], result as bigint]);
        return result;
      }
      if (call.nr !== 231) return attempt(who, call);
      inExitImport = true;
      try { return attempt(who, call); }
      finally {
        assert.equal(owner.vm.code.permits(BigInt(last), 4n, 'write'), false, 'exit request revokes guest access immediately');
        assert.deepEqual(snapshot(), words, 'no clear while the syscall import still owns a frame');
        inExitImport = false;
      }
    };
    try {
      assert.equal(syscall(owner.p, 218, [last]), BigInt(-E.NOSYS), 'registration requires the original syscall context');
      calls.length = 0;
      k.ready(owner.task);
      assert.deepEqual(k.pump(), {waiting: true});
      const tid = BigInt(owner.task.tid);
      assert.deepEqual(calls.slice(), [[BigInt(first), tid], [BigInt(mode === 'cancel' ? 0 : last), tid]]);
      assert.deepEqual(owner.vm.userMemory(owner.p).copyIn(first, 8), words, 'registration does not dereference the address');
      if (mode === 'read-only') assert.equal(syscall(owner.p, 10, [data, PAGE, 1]), 0n);
      full = false;
      assert.deepEqual(k.pump(), {status: 42 << 8});
      assert.deepEqual(output, ['mapped\n']);
      assert.equal(owner.task.clearTid, 0);
      assert.equal(rawViews, 0);
      assert.equal(reported, 1);
      assert.equal(owner.memory.users, 0);
    } finally { k.halt(); }
  });
}

test('an unconfirmed mapped compiler retirement retains its owners and never publishes exit', {skip}, async () => {
  const t = await loadTranslator(readFileSync(wasm!)), compiler = t.mapped!, vfs = new Vfs();
  const f = fixture(vfs, 'tid'), k = new Kernel({vfs, translate: t, console: consoleOut});
  const unavailable = new Error('Compiler cleanup unavailable');
  let requested = 0, stopped = 0;
  const owner = mappedTask(k, t, {...compiler, close() { requested++; throw unavailable; }}, f);
  const address = data + 20;
  owner.task.setReg(13, address);
  owner.vm.userMemory(owner.p).copyOut(address, Uint8Array.of(1, 2, 3, 4));
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
  assert.deepEqual(new Uint8Array(owner.memory.buffer, address, 4), Uint8Array.of(1, 2, 3, 4),
    'uncertain backend retirement does not publish clear-tid');
  assert.equal(owner.stdout.closed, false);
  assert.equal(owner.vm.code.find(owner.pc, owner.vm.code.generation), undefined);
  assert.equal(owner.vm.code.permits(BigInt(data), 1n, 'read'), false);
  for (const doIt of [() => k.pump(), () => k.halt(), () => k.ended(), () => k.free()]) assert.throws(doIt, e => e === failure);
  assert.equal(k.retireInitialMounts(), false);
  assert.equal(requested, 1, 'uncertain retirement is never retried');
  assert.throws(() => new Kernel({vfs, console: consoleOut}), /unresolved transaction/);
});
