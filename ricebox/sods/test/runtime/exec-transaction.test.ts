import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {Description} from '../../runtime/linux/fd.ts';
import {E, FsError, MNT, mountTarget} from '../../runtime/linux/fs.ts';
import {ExecCommitError, Kernel, PROFILE, Task, type Image} from '../../runtime/linux/process.ts';
import type {Mem} from '../../runtime/linux/parts.ts';
import {captureExecutableSource, linux, RemoteKernel} from '../../runtime/linux.ts';
import {loadTranslator, prepare} from '../../runtime/translate.ts';

const enc = new TextEncoder(), dec = new TextDecoder();
const quiet = {read: () => null, write() {}};
const elf = Uint8Array.of(0x7f, 0x45, 0x4c, 0x46);
const errno = (value: number) => (e: unknown): boolean => e instanceof FsError && e.errno === value;

function artifact(): Uint8Array<ArrayBuffer> {
  const name = enc.encode('sods.facts'), facts = enc.encode('{"entry":4096,"imageEnd":8192,"phdr":0,"phent":56,"phnum":0}');
  return Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 0, 1 + name.length + facts.length, name.length, ...name, ...facts);
}

// This task never runs guest code; it isolates ownership and rejection in the
// same transaction that the separately built guest exercises below.
class BookkeepingTask extends Task {
  override load(image: Image, memory: Mem): void { this.image = image; this.memory = memory; }
  override renew(): void {}
  override setReg(): void {}
}

function bookkeeping(translate = (_bytes: Uint8Array) => artifact()): Kernel {
  const kernel = new Kernel({translate, console: quiet});
  kernel.newTask = p => new BookkeepingTask(p);
  kernel.vfs.writeFile('/start', elf, 0o755);
  kernel.vfs.writeFile('/next', elf, 0o755);
  return kernel;
}

test('failed initial ordinary exec never publishes a task, cgroup member or PID', () => {
  const k = bookkeeping(), refs = k.root.mnt.refs;
  assert.throws(() => k.start('/absent', ['/absent'], []), errno(E.NOENT));
  assert.equal(k.root.mnt.refs, refs);
  assert.equal(k.procs.size, 0); assert.equal(k.tasks.size, 0); assert.equal(k.cgroups.root.procs.size, 0);
  assert.deepEqual(k.tty, {sid: 0, fg: 0});
  assert.equal(k.nextPid, 1); assert.equal(k.status, null);
  k.start('/start', ['/start'], []);
  assert.equal(k.initOf()?.pid, 1); assert.equal(k.runq.length, 1);
  k.halt();
});

test('an initial exec that loses permission retires its private owners without an exit event', () => {
  const k = bookkeeping(), refs = k.root.mnt.refs, source = k.vfs.file('/start');
  const observed: string[] = [], candidates: Task[] = [];
  k.newTask = p => {
    const t = new BookkeepingTask(p);
    candidates.push(t);
    source.mode &= ~0o111; // The ordinary permission recheck refuses this exec.
    const observe = (what: string) => {
      assert.equal(p.execTransition, true);
      assert.equal(t.dead, true);
      assert.equal(k.initOf(), undefined);
      observed.push(what);
    };
    t.end = () => observe('task');
    p.fds.get(1)!.gone = () => observe('stdout');
    return t;
  };
  assert.throws(() => k.start('/start', ['/start'], []), errno(E.ACCES));
  assert.equal(candidates.length, 1);
  assert.deepEqual(observed, ['task', 'stdout']);
  const [t] = candidates, p = t.proc;
  assert.equal(t.state, 'dead');
  assert.equal(p.state, 'zombie');
  assert.equal(p.own, undefined);
  assert.equal(p.exitStatus, undefined);
  assert.equal(p.execTransition, undefined);
  assert.deepEqual([p.fds.holders, p.fds.slots.size, p.fs.users, k.runq.length, k.root.mnt.refs], [0, 0, 0, 0, refs]);
  assert.equal(k.status, null);
  k.halt();
});

test('ordinary and source-bound AOT initial cancellation retain one failed private close', () => {
  for (const aot of [false, true]) {
    const k = bookkeeping(), source = k.vfs.file('/start'), refs = k.root.mnt.refs;
    if (aot) {
      const origin = source.origin = 'initial cancellation fixture';
      const grant = captureExecutableSource(k.vfs, '/start', {origin, size: source.size});
      assert.ok(k.prebuiltSource(grant, new WebAssembly.Module(artifact())));
    }
    const cleanup = new Error('Unconfirmed console close'), released: string[] = [];
    let task: Task | undefined;
    k.newTask = p => {
      const t = task = new BookkeepingTask(p);
      source.mode &= ~0o111;
      t.end = () => {
        assert.equal(t.dead, true);
        assert.equal(p.execTransition, true);
        released.push('task');
      };
      p.fds.get(1)!.gone = () => {
        assert.equal(p.fs.users, 0);
        released.push('stdout');
        throw cleanup;
      };
      p.fds.get(2)!.gone = () => { released.push('stderr'); };
      return t;
    };
    assert.throws(() => k.start('/start', ['/start'], []), (error: unknown) => {
      assert.ok(error instanceof ExecCommitError && error.phase === 'initial-preparation');
      assert.ok(error.cause instanceof AggregateError);
      assert.equal(error.cause.errors.length, 2);
      assert.equal(errno(E.ACCES)(error.cause.errors[0]), true);
      assert.equal(error.cause.errors[1], cleanup);
      assert.equal(error.owners.task, task);
      assert.equal(error.owners.newFds, task?.proc.fds);
      return true;
    });
    const p = task!.proc, failure = p.execFailure;
    assert.deepEqual([p.fs.users, p.fds.holders, p.fds.slots.size, k.root.mnt.refs], [0, 0, 0, refs]);
    assert.deepEqual([k.procs.size, k.tasks.size, k.runq.length, k.status, p.exitStatus], [0, 0, 0, null, undefined]);
    assert.throws(() => k.halt(), error => error === failure);
    assert.deepEqual(released, ['task', 'stdout', 'stderr']);
  }
});

test('a stopped kernel cannot publish an initial exec after its source callback returns', () => {
  const k = bookkeeping(() => { k.halt(); return artifact(); });
  assert.throws(() => k.start('/start', ['/start'], []), /Exec preparation lost/);
  assert.equal(k.procs.size, 0); assert.equal(k.tasks.size, 0);
  assert.equal(k.cgroups.root.procs.size, 0); assert.equal(k.nextPid, 1);
});

test('a shared FD-table copy failure returns before exec can retire the old process image', () => {
  const k = bookkeeping();
  k.start('/start', ['/start'], []);
  const p = k.initOf()!, t = p.task, old = p.memory, image = p.image, table = p.fds;
  p.bytes.set(enc.encode('/next\0'), p.stackLow);
  table.share();
  let closed = 0;
  const a = new Description('console'), b = new Description('console');
  a.gone = () => { closed++; };
  table.install(a, {fd: 3, cloexec: true});
  table.install(b, {fd: 4});
  b.retain = () => { throw new FsError(E.NOMEM); };
  assert.equal(p.syscall(59n, BigInt(p.stackLow), 0n, 0n, 0n, 0n, 0n), -BigInt(E.NOMEM));
  assert.equal(p.task, t); assert.equal(t.dead, false);
  assert.equal(p.image, image); assert.equal(p.memory, old); assert.equal(p.exe, '/start');
  assert.equal(p.fds, table); assert.equal(table.holders, 2); assert.equal(table.get(3), a); assert.equal(a.refs, 1);
  assert.equal(closed, 0); assert.equal(p.execFailure, undefined);
  table.letGo(); k.halt();
  assert.equal(closed, 1);
});

test('a checked stack overflow and a changed execute grant leave the old image running', () => {
  let revoke = false;
  const k = bookkeeping(() => { if (revoke) k.root.mnt.flags |= MNT.NOEXEC; return artifact(); });
  k.start('/start', ['/start'], []);
  const p = k.initOf()!, image = p.image, memory = p.memory, table = p.fds;
  assert.throws(() => p.execve('/start', ['/start'], ['x'.repeat(8 << 20)]), errno(E.TOOBIG));
  revoke = true;
  assert.throws(() => p.execve('/next', ['/next'], []), errno(E.ACCES));
  assert.equal(p.image, image); assert.equal(p.memory, memory); assert.equal(p.fds, table);
  assert.equal(p.exe, '/start'); assert.equal(p.execFailure, undefined);
  k.halt();
});

test('an irreversible close failure is a retained host error, never errno, resume or duplicate retirement', () => {
  const k = bookkeeping();
  k.start('/start', ['/start'], []);
  const p = k.initOf()!, task = p.task, table = p.fds, oldMemory = p.memory!, closed = new Description('console');
  const cause = new FsError(E.IO);
  let closes = 0;
  closed.gone = () => { closes++; throw cause; };
  table.install(closed, {fd: 3, cloexec: true});
  p.bytes.set(enc.encode('/next\0'), p.stackLow);
  assert.throws(() => p.syscall(59n, BigInt(p.stackLow), 0n, 0n, 0n, 0n, 0n), (e: unknown) =>
    e instanceof ExecCommitError && e.phase === 'descriptors' && e.cause === cause && e.process === p && e.owners.oldFds === table);
  const retained = p.execFailure!;
  assert.equal(k.failedExecs!.has(retained), true);
  assert.equal(retained.owners.oldMemory, oldMemory);
  assert.equal(k.spareMemories.includes(oldMemory), false);
  assert.equal(oldMemory.tainted, true); assert.equal(p.memory!.tainted, true);
  assert.equal(table.get(3), null); assert.equal(closes, 1);
  assert.throws(() => k.run(task), error => error === retained);
  assert.throws(() => k.halt(), error => error === retained);
  assert.equal(k.retireInitialMounts(), false);
  assert.throws(() => new Kernel({vfs: k.vfs, console: quiet}), /unresolved transaction/);
  assert.equal(closes, 1);
});


test('a descriptor mutation during shared table preparation does not install the stale copy', () => {
  const k = bookkeeping();
  k.start('/start', ['/start'], []);
  const p = k.initOf()!, {fds: table, image, memory} = p;
  table.share();
  const a = new Description('console'), b = new Description('console');
  table.install(a, {fd: 3}); table.install(b, {fd: 4});
  const retain = b.retain.bind(b);
  b.retain = () => { table.setCloexec(3, true); return retain(); };
  assert.throws(() => p.execve('/next', ['/next'], []), /Exec preparation lost/);
  assert.equal(p.fds, table); assert.equal(p.image, image); assert.equal(p.memory, memory);
  assert.equal(table.holders, 2); assert.equal(table.cloexec(3), true); // The caller's write was not rolled back.
  assert.equal(a.refs, 1); assert.equal(b.refs, 1); assert.equal(p.execFailure, undefined);
  table.letGo(); k.halt();
});

test('a script loop and restricted exec do not widen static admission or credentials', () => {
  const k = bookkeeping();
  k.vfs.writeFile('/loop', '#!/loop\n', 0o755);
  const next = k.vfs.file('/next');
  next.mode |= 0o4000;
  next.uid = 123;
  k.start('/start', ['/start'], []);
  const p = k.initOf()!;
  assert.throws(() => p.execve('/loop', ['/loop'], []), errno(E.LOOP));
  assert.equal(p.exe, '/start');
  p.noNewPrivs = true;
  p.execve('/next', ['/next'], []);
  assert.equal(p.exe, '/next'); assert.equal(p.cred.euid, 0); assert.equal(p.noNewPrivs, true);
  k.halt();
});

test('a failed take from the old memory pool retains the exact candidate, not another owner', () => {
  const k = bookkeeping();
  k.start('/start', ['/start'], []);
  const p = k.initOf()!, old = p.memory!;
  const pooled: Mem = Object.assign(new WebAssembly.Memory({initial: 1}),
    {users: 0, written: [], keeps: false, imageOf: null});
  k.spareMemories.push(pooled);
  const cause = new Error('failed backend reuse');
  k.reuseMemory = m => { assert.equal(m, pooled); throw cause; };
  assert.throws(() => p.execve('/next', ['/next'], []), (e: unknown) =>
    e instanceof ExecCommitError && e.phase === 'address-space' && e.cause === cause &&
    e.owners.oldMemory === old && e.owners.newMemory === pooled);
  assert.equal(k.spareMemories.includes(pooled), false);
  assert.equal(old.tainted, true); assert.equal(pooled.tainted, true);
});

const translatorPath = process.env.SODS_CURRENT_TRANSLATOR_WASM;
const skip = !translatorPath ? 'requires the current Sods translator artifact'
  : process.platform !== 'linux' || process.arch !== 'x64' ? 'compares with native Linux x86-64' : false;

test('real static guest execve, vfork and shebang match native status, argv, environment and descriptors', {skip, timeout: 30_000}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sods-exec-transaction-'));
  try {
    for (const name of ['runner','target']) {
      const source = fileURLToPath(new URL(`../fixtures/exec/${name}.S`, import.meta.url));
      execFileSync(process.env.SODS_FIXTURE_CC ?? 'cc', ['-nostdlib', '-static', '-no-pie', '-Wl,--build-id=none,--emit-relocs',
        source, '-o', join(directory, name)], {timeout: 8_000});
    }
    writeFileSync(join(directory, 'script'), '#!./target shebang\n', {mode: 0o755});
    writeFileSync(join(directory, 'token'), 'fixture\n');
    const runner = new Uint8Array(readFileSync(join(directory, 'runner')));
    const target = new Uint8Array(readFileSync(join(directory, 'target')));
    const translator = await loadTranslator(readFileSync(translatorPath!));
    const compiled = translator.whole(target);
    const targetWasm = prepare(compiled);
    const targetShared = prepare(compiled, {shared: true});
    const cases = [['./target', 'e', 42, 'direct\n'], ['./target', 'v', 42, 'direct\n'],
      ['./script', 'e', 42, 'shebang\n'], ['./missing', 'e', 2, '']] as const;

    for (const [path, mode, expected, output] of cases) {
      const native = spawnSync(join(directory, 'runner'), [path, mode], {cwd: directory, env: {}, timeout: 4_000, encoding: 'utf8'});
      assert.equal(native.error, undefined); assert.equal(native.signal, null);
      assert.equal(native.status, expected, `${path}/${mode}`); assert.equal(native.stdout, output); assert.equal(native.stderr, '');
      for (const inline of [true, false]) {
        let guest = '', stderr = '', fileReads = 0, kept = 0;
        const wasm = inline ? targetWasm : targetShared;
        const module = new WebAssembly.Module(wasm.wasm);
        const k = linux({inline, translate: translator,
          console: {read: () => null, write(fd, bytes) { if (fd === 2) stderr += dec.decode(bytes); else guest += dec.decode(bytes); }},
          keeper: {has: origin => origin === 'fixture-target',
            take: () => {
              kept++;
              return {module, segments: wasm.segments, size: wasm.wasm.length, more: []};
            },
          },
        });
        try {
          assert.equal(k instanceof RemoteKernel, !inline);
          k.vfs.writeFile('/runner', runner, 0o755);
          mountTarget(k.vfs).file('/target', 0o755, target.length, () => { fileReads++; return target; }, 'fixture-target');
          k.vfs.writeFile('/script', readFileSync(join(directory, 'script')), 0o755);
          k.vfs.writeFile('/token', 'fixture\n');
          assert.equal(await k.spawn('/runner', ['/runner', path, mode], [], '/'), expected << 8, `${path}/${mode}, inline=${inline}`);
          assert.equal(guest, output); assert.equal(stderr, ''); assert.equal(fileReads, 0);
          assert.equal(kept, path === './missing' ? 0 : 1);
        } finally { k.halt(); }
      }
    }

    for (const prebuilt of [true, false]) {
      let reads = 0, translations = 0;
      const k = new Kernel({translate: Object.assign((bytes: Uint8Array) => { translations++; return translator(bytes); }, {module: translator.module}), console: quiet});
      try {
        const file = mountTarget(k.vfs).file('/target', 0o755, target.length, () => { reads++; return target; }, 'fixture-target');
        if (prebuilt) k.prebuilt(file, new WebAssembly.Module(targetWasm.wasm), targetWasm.segments);
        const before = PROFILE.renewed;
        k.start('/target', ['/target', 'one'], []);
        const p = k.initOf()!, original = p.memory, instance = p.task.instance;
        const cold = prebuilt ? 0 : 1;
        assert.equal(reads, cold); assert.equal(translations, cold);
        p.execve('/target', ['/target', 'two'], []);
        assert.equal(p.memory, original); assert.equal(p.task.instance, instance);
        assert.equal(PROFILE.renewed - before, 1);
        assert.equal(reads, cold); assert.equal(translations, cold);
      } finally { k.halt(); }
    }
  } finally { rmSync(directory, {recursive: true, force: true}); }
});
