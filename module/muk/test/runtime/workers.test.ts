import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RemoteKernel} from '../../runtime/remote.ts';
import {Process} from '../../runtime/process.ts';
import {CH} from '../../runtime/channel.ts';

// The Workers a kernel runs its threads on (remote.ts), as the host tells of them: here each is a hand of the test's
// own (no Worker is started), its events fired by the test. Each test is one finding closed; the numbers in the names
// are the issues'.

/** A Worker's place: what the kernel would post to and hear from, the test firing its events. */
function hand() {
  let message: (m: never) => void = () => {}, error: (e: {message?: string}) => void = () => {};
  const w = {
    ended: 0,
    failed: false,
    post(_m: unknown) {},
    end() { w.ended++; },
    on(fn: (m: never) => void) { message = fn; },
    onError(fn: (e: {message?: string}) => void) { error = fn; },
    /** The host's error event (the Worker could not start, or threw outside what cpu.ts catches). */
    fail() { error({message: 'injected host Worker failure'}); },
    /** cpu.ts's own word that its thread failed. */
    say() { message({type: 'error', message: 'injected cpu error'} as never); },
  };
  return w;
}
type Hand = ReturnType<typeof hand>;
type Adopted = Parameters<RemoteKernel['adoptWorker']>[0];

/** A kernel with no Worker of its own, what it said on its console, and the hands it was given for those it asked for. */
function bench() {
  const output: string[] = [], made: Hand[] = [];
  const k = new RemoteKernel({spares: 0, console: {write(_fd: number, b: Uint8Array) { output.push(new TextDecoder().decode(b)); }, read() { return null; }}});
  k.spawnWorker = () => { const w = hand(); made.push(w); return k.adoptWorker(w as unknown as Adopted); };
  return {k, output, made};
}
/** A process of one thread running on a hand, under `parent` (init with none). */
function running(k: RemoteKernel, parent: Process | null = null) {
  const p = new Process(k, parent), t = k.newTask(p), w = hand();
  p.pid = t.tid;
  if (!parent) p.pgid = p.sid = p.pid;
  p.tasks.add(t);
  p.task = t;
  k.procs.set(p.pid, p);
  k.tasks.set(t.tid, t);
  t.state = 'running';
  t.worker = k.adoptWorker(w as unknown as Adopted);
  return {p, t, w};
}
const soon = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settled = (serving: Promise<number>, ms = 200) => Promise.race([serving.then((s) => `settled:${s}`), soon(ms).then(() => 'pending')]);

test('#118: a thread whose Worker the host says failed is ended as one whose Worker said so itself: the kernel is woken and its run settles', async () => {
  for (const how of ['fail', 'say'] as const) {
    const {k, output} = bench(), {p, t, w} = running(k);
    const serving = k.serve();
    await soon(10);
    w[how]();
    // (Before, for the host's word: said on stderr and nothing else; the run waited for ever.)
    assert.equal(await settled(serving), 'settled:11', how);
    assert.deepEqual([p.state, t.dead, k.tasks.size, k.status], ['zombie', true, 0, 11], how);
    assert.ok(output.join('').includes('injected'), how);
    // Its Worker was running guest code: it is ended, and not kept for another thread.
    assert.equal(k.spares.length, 0, how);
    if (how === 'fail') assert.equal(w.ended, 1);
  }
});

test('#118: said twice, a Worker\'s failure ends its thread and the Worker once', async () => {
  const {k} = bench(), {t, w} = running(k);
  const serving = k.serve();
  await soon(10);
  w.fail();
  w.fail();
  assert.equal(await settled(serving), 'settled:11');
  assert.deepEqual([w.ended, t.dead], [1, true]);
  // And said after its thread is gone, nothing more is ended.
  w.fail();
  assert.equal(w.ended, 1);
});

test('#118: a Worker kept spare that fails is not given to a thread: it is taken out and ended, and the next thread has another', () => {
  const {k, made} = bench(), broken = hand(), sound = hand();
  k.spares.push(k.adoptWorker(sound as unknown as Adopted), k.adoptWorker(broken as unknown as Adopted));
  broken.fail();
  // (Before: it stayed, and was the next one handed out.)
  assert.deepEqual([k.spares.length, broken.ended, sound.ended], [1, 1, 0]);
  assert.equal(k.worker() as unknown, sound);
  // None left: another is started, never the one that failed.
  const next = k.worker() as unknown;
  assert.deepEqual([next === broken, next === made[0], made.length], [false, true, 1]);
  k.close();
});

test('#118: a thread ended while it waits in a call leaves its Worker for the next thread, unless the Worker failed', () => {
  // Sound: kept, not ended.
  const sound = bench(), a = running(sound.k);
  Atomics.store(a.t.i32, CH.STATE, 1);
  sound.k.exitProcess(a.p, 0);
  assert.deepEqual([sound.k.spares.includes(a.w as unknown as Adopted), a.w.ended], [true, 0]);
  sound.k.close();
  // Failed while its thread waited there: ended once, and not kept.
  const failing = bench(), b = running(failing.k);
  Atomics.store(b.t.i32, CH.STATE, 1);
  b.w.fail();
  assert.deepEqual([failing.k.spares.length, b.w.ended, b.p.state, b.p.exitStatus], [0, 1, 'zombie', 11]);
  failing.k.close();
});

test('#118: a child whose Worker fails ends alone: its parent is told and may wait for it, and the rest runs on', async () => {
  const {k} = bench(), init = running(k), child = running(k, init.p), other = running(k, init.p);
  const serving = k.serve();
  await soon(10);
  child.w.fail();
  await soon(10);
  // The child is a zombie for its parent to wait for (ended as by SIGSEGV); init and its other child live on.
  assert.deepEqual([child.p.state, child.p.exitStatus, child.t.dead, child.w.ended], ['zombie', 11, true, 1]);
  assert.deepEqual([init.p.state, other.p.state, k.status, init.w.ended, other.w.ended], ['live', 'live', null, 0, 0]);
  assert.equal(k.procs.get(child.p.pid), child.p);
  assert.equal(await settled(serving, 30), 'pending');
  k.halt();
  assert.equal(await serving, 9);
});
