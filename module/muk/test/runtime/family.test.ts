import assert from 'node:assert/strict';
import {test} from 'node:test';
// The runtime loads its call tables through process.ts, as the worker does.
import {Kernel, Process, Task} from '../../runtime/process.ts';
import {Description, Pipe} from '../../runtime/fd.ts';

// Processes and what they hold together, each as a guest's own calls (clone, exit, prctl, prlimit64, wait4) on a
// kernel whose threads only hold their registers: no program is translated or run. Each test is one finding closed;
// the numbers in the names are the issues'. What Linux does with each was asked of Linux.

const CLONE = 56, EXIT_GROUP = 231, PRCTL = 157, PRLIMIT64 = 302, WAIT4 = 61, CLOSE = 3, WRITE = 1, READ = 0, GETPPID = 110, DUP = 32, PIPE = 22;
const CLONE_VM = 0x100, CLONE_FILES = 0x400, SIGCHLD = 17;
const PR_SET_CHILD_SUBREAPER = 36, PR_GET_CHILD_SUBREAPER = 37, RLIMIT_NOFILE = 7;
const ECHILD = -10n, EINVAL = -22n, EPERM = -1n, EMFILE = -24n;

/** A thread that holds its registers and runs nothing. */
class Bare extends Task {
  regs: bigint[] = new Array<bigint>(17).fill(0n);
  override load(): void {}
  override reg(n: number): bigint { return this.regs[n] ?? 0n; }
  override setReg(n: number, v: bigint | number): void { this.regs[n] = BigInt.asIntN(64, BigInt(v)); }
  override low(): bigint | null { return null; }
  override context(): {regs: bigint[]; rip: bigint} { return {regs: [...this.regs], rip: this.resumeAt}; }
  override setContext(regs: bigint[], rip: bigint): void { this.regs = [...regs]; this.resumeAt = rip; }
}
class Bench extends Kernel {
  override newTask(proc: Process): Task { return new Bare(proc, this.nextPid++); }
}

/** A kernel with its first process (pid 1), one page of memory, a thread that runs nothing. */
function first(): Process {
  const kernel = new Bench({translate() { throw new Error('unused'); }, console: {write() {}, read: () => new Uint8Array(0)}});
  const p = new Process(kernel, null);
  p.memory = Object.assign(new WebAssembly.Memory({initial: 1}), {users: 1, written: [], keeps: false, imageOf: null});
  // (What a program's start would have set: no stack and nothing mapped.)
  Object.assign(p, {free: [], fixed: [], stackLow: 0, stackTop: 0, mapBase: 0, mapEnd: 0});
  const t = kernel.newTask(p);
  p.pid = p.pgid = p.sid = t.tid;
  p.tasks.add(t);
  kernel.procs.set(p.pid, p);
  kernel.tasks.set(t.tid, t);
  return p;
}
const call = (p: Process, nr: number, ...args: (number | bigint)[]): bigint =>
  p.syscall(BigInt(nr), ...([...args, 0, 0, 0, 0, 0, 0].slice(0, 6).map(BigInt) as [bigint, bigint, bigint, bigint, bigint, bigint]));
/** A child of `p` by clone with `flags` (its memory shared: nothing is copied). */
function child(p: Process, flags = 0): Process {
  const pid = Number(call(p, CLONE, CLONE_VM | flags | SIGCHLD));
  assert.ok(pid > 0, `clone: ${pid}`);
  return p.kernel.procs.get(pid)!;
}
const exit = (p: Process, code = 0): void => { try { call(p, EXIT_GROUP, code); } catch { /* it ended: nothing comes back */ } };

test('#109: prlimit64 with the new limits and the old in one place sets what was asked and gives back what was', () => {
  const p = first();
  const at = (where: number): [bigint, bigint] => [p.view.getBigUint64(where, true), p.view.getBigUint64(where + 8, true)];
  const put = (where: number, soft: bigint, hard: bigint): void => { p.view.setBigUint64(where, soft, true); p.view.setBigUint64(where + 8, hard, true); };
  const prlimit = (next: number, old: number, resource = RLIMIT_NOFILE) => call(p, PRLIMIT64, 0, resource, next, old);
  const [soft, hard] = p.limits[RLIMIT_NOFILE];
  // One place for both (prlimit64(0, r, &l, &l)): what Linux does was asked of Linux. (Before: the old limits were
  // written there first, read back as the new ones, and "set": the call said 0 and nothing changed.)
  put(1024, 100n, hard);
  assert.equal(prlimit(1024, 1024), 0n);
  assert.deepEqual(p.limits[RLIMIT_NOFILE], [100n, hard]);
  assert.deepEqual(at(1024), [soft, hard]);
  // The two a word apart, one over the other's half.
  put(2048, 90n, hard);
  assert.equal(prlimit(2048, 2056), 0n);
  assert.deepEqual(p.limits[RLIMIT_NOFILE], [90n, hard]);
  assert.deepEqual(at(2056), [100n, hard]);
  // Apart; the old alone; the new alone.
  put(3072, 80n, hard);
  assert.equal(prlimit(3072, 4096), 0n);
  assert.deepEqual([p.limits[RLIMIT_NOFILE], at(4096)], [[80n, hard], [90n, hard]]);
  assert.equal(prlimit(0, 4096), 0n);
  assert.deepEqual([p.limits[RLIMIT_NOFILE], at(4096)], [[80n, hard], [80n, hard]]);
  put(3072, 70n, 500n);
  assert.equal(prlimit(3072, 0), 0n);
  assert.deepEqual(p.limits[RLIMIT_NOFILE], [70n, 500n]);
  // Refused, nothing is set and nothing is written where the old limits were wanted (Linux writes them only once the
  // new ones are set): more than its hard limit, a hard limit raised, a resource there is none of.
  for (const [what, said, s, h, resource] of [['soft over hard', EINVAL, 200n, 100n, RLIMIT_NOFILE], ['hard raised', EPERM, 10n, 501n, RLIMIT_NOFILE],
    ['no such resource', EINVAL, 1n, 1n, 99]] as [string, bigint, bigint, bigint, number][]) {
    put(1024, s, h);
    assert.equal(prlimit(1024, 1024, resource), said, what);
    assert.deepEqual(p.limits[RLIMIT_NOFILE], [70n, 500n], what);
    assert.deepEqual(at(1024), [s, h], what);
  }
  // The soft limit is the descriptors' own: none at or past it.
  put(1024, 1n, 500n);
  assert.equal(prlimit(1024, 0), 0n);
  p.fds.install(new Description('eventfd'), {fd: 0});
  assert.equal(call(p, DUP, 0), EMFILE);
  put(1024, 2n, 500n);
  assert.equal(prlimit(1024, 0), 0n);
  assert.equal(call(p, DUP, 0), 1n);
});

/** What `p`'s wait4 for any child gives without waiting: [pid, exit status], or the errno. */
function waited(p: Process): [number, number] | bigint {
  const pid = call(p, WAIT4, -1, 4096, 1 /* WNOHANG */);
  return pid <= 0n ? pid : [Number(pid), (p.view.getInt32(4096, true) >> 8) & 0xff];
}

test('#108: an orphan goes to the nearest process above it that asked for orphans, else to init, and that one waits for it', () => {
  // What Linux does with each was asked of Linux (prctl PR_SET_CHILD_SUBREAPER, fork, getppid, waitpid).
  const init = first();
  const a = child(init), b = child(a), c = child(b);
  assert.equal(call(a, PRCTL, PR_SET_CHILD_SUBREAPER, 1), 0n);
  assert.equal(call(a, PRCTL, PR_GET_CHILD_SUBREAPER, 1024), 0n);
  assert.equal(a.view.getInt32(1024, true), 1);
  // Its parent ended: it is A's, not init's, and A waits for it. (Before: every orphan went to pid 1, whoever asked.)
  exit(b);
  assert.equal(call(c, GETPPID), BigInt(a.pid));
  assert.deepEqual([a.children.has(c), init.children.has(c)], [true, false]);
  assert.deepEqual(waited(a), [b.pid, 0]);
  assert.equal(waited(a), 0n);
  exit(c, 7);
  assert.deepEqual(waited(a), [c.pid, 7]);
  assert.equal(waited(a), ECHILD);
  // One already ended whose parent never waited for it is handed on too, and waited for there.
  const b2 = child(a), z = child(b2);
  exit(z, 5);
  exit(b2);
  assert.equal(z.ppid, a.pid);
  assert.deepEqual([waited(a), waited(a)].sort(), [[b2.pid, 0], [z.pid, 5]].sort());
  assert.equal(waited(a), ECHILD);
  assert.equal(init.children.size, 1);
  // Two above that asked: the nearer one.
  const a2 = child(a), b3 = child(a2), c3 = child(b3);
  assert.equal(call(a2, PRCTL, PR_SET_CHILD_SUBREAPER, 1), 0n);
  exit(b3);
  assert.equal(c3.ppid, a2.pid);
  assert.ok(a2.children.has(c3) && !a.children.has(c3));
  // That one ended: the next above that asked.
  exit(a2);
  assert.equal(c3.ppid, a.pid);
  assert.ok(a.children.has(c3));
  // Asked no more (prctl 0): to init, and A has no such child.
  assert.equal(call(a, PRCTL, PR_SET_CHILD_SUBREAPER, 0), 0n);
  const b4 = child(a), c4 = child(b4);
  exit(b4);
  assert.equal(c4.ppid, init.pid);
  assert.deepEqual([init.children.has(c4), a.children.has(c4)], [true, false]);
  // Everyone's parent is who holds it as a child.
  for (const p of init.kernel.procs.values()) for (const q of p.children) assert.equal(q.ppid, p.pid, `${q.pid}`);
});

test('#107: a table of descriptors shared by clone is one table held by each: one ending leaves it to the other, the last closes it', () => {
  const p = first(), pipe = new Pipe();
  const reader = new Description('pipe-r', {pipe}), writer = new Description('pipe-w', {pipe});
  p.fds.install(reader, {fd: 0});
  p.fds.install(writer, {fd: 1});
  // Shared (CLONE_FILES): the one table, each descriptor held once by it. (Before: the child was first given a copy,
  // thrown away with each of its descriptions still held; and its end closed the table under its parent.)
  const c = child(p, CLONE_FILES);
  assert.equal(c.fds, p.fds);
  assert.deepEqual([reader.refs, writer.refs], [1, 1]);
  // A close by one is seen by the other, and an open too.
  const more = Number(call(c, DUP, 1));
  assert.equal(p.fds.get(more), writer);
  assert.equal(call(p, CLOSE, more), 0n);
  assert.equal(c.fds.get(more), null);
  // The child ends: the parent's descriptors are as they were, and still written and read through.
  exit(c);
  assert.deepEqual([p.fds.get(0), p.fds.get(1)], [reader, writer]);
  assert.deepEqual([reader.refs, writer.refs, reader.closed, writer.closed], [1, 1, false, false]);
  p.bytes.set([104, 105], 1024);
  assert.equal(call(p, WRITE, 1, 1024, 2), 2n);
  assert.equal(call(p, READ, 0, 2048, 16), 2n);
  assert.deepEqual([...p.bytes.subarray(2048, 2050)], [104, 105]);
  // Not shared (a fork): a table of its own, each description held once more, let go when it ends.
  const f = child(p);
  assert.notEqual(f.fds, p.fds);
  assert.deepEqual([reader.refs, writer.refs], [2, 2]);
  exit(f);
  assert.deepEqual([reader.refs, writer.refs, writer.closed], [1, 1, false]);
  // Shared, and the one it was shared from ends first: the other still has it; the last of them to end closes it.
  const q = child(p), s = child(q, CLONE_FILES);
  assert.equal(s.fds, q.fds);
  assert.deepEqual([reader.refs, writer.refs], [2, 2]);
  assert.equal(call(s, CLOSE, 0), 0n);
  assert.equal(reader.refs, 1);
  exit(q);
  assert.deepEqual([s.fds.get(1), writer.refs, writer.closed], [writer, 2, false]);
  exit(s);
  assert.deepEqual([writer.refs, writer.closed, pipe.writers], [1, false, 1]);
  // The last holder of each description gone, it is closed, once: the pipe has no writer and no reader.
  exit(p);
  assert.deepEqual([reader.refs, writer.refs, reader.closed, writer.closed, pipe.readers, pipe.writers], [0, 0, true, true, 0, 0]);
});

test('a pipe or a dup with too few descriptors left is EMFILE and leaves nothing behind', () => {
  // What Linux says with none, one and two descriptors left was asked of Linux (RLIMIT_NOFILE filled by dup).
  const p = first();
  p.fds.install(new Description('eventfd'), {fd: 0});
  const open = () => [...p.fds.slots.keys()].join(' ');
  for (const [left, pipeSays, dupSays] of [[0, EMFILE, EMFILE], [1, EMFILE, 1n], [2, 0n, 1n]] as [number, bigint, bigint][]) {
    p.fds.limit = 1 + left;
    // (Where the two descriptors are written is marked first, to see that nothing is written there when it is refused.)
    p.view.setInt32(1024, 77, true);
    p.view.setInt32(1028, 77, true);
    assert.equal(call(p, PIPE, 1024), pipeSays, `pipe, ${left} left`);
    if (pipeSays === 0n) {
      assert.deepEqual([p.view.getInt32(1024, true), p.view.getInt32(1028, true), open()], [1, 2, '0 1 2']);
      assert.deepEqual([p.fds.get(1)!.kind, p.fds.get(2)!.kind], ['pipe-r', 'pipe-w']);
      assert.equal(call(p, CLOSE, 1), 0n);
      assert.equal(call(p, CLOSE, 2), 0n);
    } else {
      assert.deepEqual([p.view.getInt32(1024, true), p.view.getInt32(1028, true), open()], [77, 77, '0'], `pipe, ${left} left`);
    }
    assert.equal(call(p, DUP, 0), dupSays, `dup, ${left} left`);
    if (dupSays > 0n) assert.equal(call(p, CLOSE, 1), 0n);
    assert.equal(open(), '0');
  }
});
