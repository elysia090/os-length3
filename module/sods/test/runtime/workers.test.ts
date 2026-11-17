import assert from 'node:assert/strict';
import {test} from 'node:test';
import {RemoteKernel, warmThreads} from '../../runtime/linux/remote.ts';
import {Process} from '../../runtime/linux/process.ts';
import {CH} from '../../runtime/linux/channel.ts';

// The Workers a kernel runs its threads on (remote.ts), as the host tells of them: here each is a hand of the test's
// own (no Worker is started), its events fired by the test. Each test is one finding closed; the numbers in the names
// are the issues'.

/** A Worker's place: what the kernel would post to and hear from, the test firing its events. */
function hand() {
  let message: (m: never) => void = () => {};
  const heard: ((e: {message?: string}) => void)[] = [];
  const error = (e: {message?: string}) => { for (const fn of heard) fn(e); };
  const w = {
    ended: 0,
    failed: false,
    post(_m: unknown) {},
    end() { w.ended++; },
    on(fn: (m: never) => void) { message = fn; },
    onError(fn: (e: {message?: string}) => void) { heard.push(fn); },
    /** The host's error event (the Worker could not start, or threw outside what cpu.ts catches). */
    fail(message = 'injected host Worker failure') { error({message}); },
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

test('#118: a Worker started ahead that fails before a kernel has it is not handed to one; one that fails after is the kernel\'s to end', async () => {
  const early = hand(), late = hand(), made = [early, late];
  warmThreads(2, () => made.shift() as unknown as Adopted);
  early.fail();
  early.fail();
  assert.equal(early.ended, 1);
  // The kernel made next takes those started ahead: the sound one alone.
  const k = new RemoteKernel({spares: 0, console: {write() {}, read() { return null; }}});
  assert.deepEqual([k.spares.includes(early as unknown as Adopted), k.spares.includes(late as unknown as Adopted)], [false, true]);
  // The kernel's now: failing, it is taken out of its spares and ended once (by the kernel, not twice by both who hear).
  late.fail();
  assert.deepEqual([k.spares.length, late.ended], [0, 1]);
  k.close();
});

for (const phase of ['drain', 'stop'] as const) test(`forced Worker ${phase} failure taints memory before host actions`,()=>{
  const {k}=bench(),{p,t,w}=running(k),failure=Error(phase);
  const memory=Object.assign(new WebAssembly.Memory({initial:1,maximum:1,shared:true}),{users:1,written:[],keeps:false,imageOf:null,tainted:false});
  p.memory=memory;t.memory=memory;
  const gil=new Int32Array(k.gil(memory));Atomics.store(gil,0,t.tid);
  if(phase==='drain')k.lookIn=()=>{assert.equal(memory.tainted,true);throw failure;};
  else w.end=()=>{assert.equal(memory.tainted,true);w.ended++;throw failure;};
  assert.throws(()=>t.end(),e=>e===failure);
  assert.equal(memory.tainted,true);assert.equal(t.worker,null);assert.equal(k.spares.length,0);
  k.letGo(memory);assert.equal(k.spareMemories.includes(memory),false);
  // End detached the assignment: a later close is not a hidden stop retry.
  k.close();assert.equal(w.ended,phase==='stop'?1:0);
  assert.equal(Atomics.load(gil,0),t.tid); // Repeated close must not unlock unconfirmed execution.
});

test('close attempts independent captured Worker stops and preserves multiple failures',()=>{
  const {k}=bench(),a=running(k),b=running(k),first=Error('task'),second=Error('spare');
  a.w.end=()=>{a.w.ended++;throw first;};
  const bad=hand(),good=hand();bad.end=()=>{bad.ended++;throw second;};
  k.spares.push(k.adoptWorker(bad as unknown as Adopted),k.adoptWorker(good as unknown as Adopted));
  assert.throws(()=>k.close(),e=>e instanceof AggregateError&&e.errors[0]===first&&e.errors[1]===second);
  assert.deepEqual([a.w.ended,b.w.ended,bad.ended,good.ended],[1,1,1,1]);assert.equal(k.spares.length,0);
  k.close();assert.deepEqual([a.w.ended,b.w.ended,bad.ended,good.ended],[1,1,1,1]);
});

test('a failed spare is never passed to the next kernel',()=>{
  const k=new RemoteKernel({spares:0,passOn:true,console:{write(){},read(){return null;}}}),failed=hand();failed.failed=true;
  k.spares.push(k.adoptWorker(failed as unknown as Adopted));k.close();assert.equal(failed.ended,1);
  const next=new RemoteKernel({spares:0,console:{write(){},read(){return null;}}});
  assert.equal(next.spares.includes(failed as unknown as Adopted),false);next.close();
});

import {WorkerStop} from '../../runtime/linux/worker-stop.ts';
test('requested or observed-stopped spares cannot be selected or kept', () => {
  for (const state of ['requested', 'exited'] as const) {
    const {k, made} = bench();
    const w = hand() as Hand & {stop: WorkerStop};
    let exit!: (code: number) => void;
    w.stop = new WorkerStop(() => new Promise(() => {}), fn => { exit = fn; });
    if (state === 'requested') w.stop.request(() => {}); else exit(0);
    k.spares.push(k.adoptWorker(w as unknown as Adopted));
    const selected = k.worker(null);
    assert.notEqual(selected, w); assert.equal(made.length, 1);
    k.keep(w as unknown as Adopted); assert.equal(k.spares.includes(w as unknown as Adopted), false);
    k.close();
  }
});

test('explicit warm owner hears failure even if its diagnostic throws, and the hand retires', () => {
  const w = hand(), seen: unknown[] = [], failed = new Error('diagnostic sink failed');
  warmThreads({count: 1, failed(error) { seen.push(error); throw failed; }}, () => w as unknown as Adopted);
  w.fail();
  assert.equal(seen.length, 1); assert.equal(w.ended, 1);
  assert.ok(seen[0] instanceof Error); assert.match(seen[0].message, /injected host Worker failure/);
  assert.deepEqual((w as unknown as Adopted).diagnosticFailures, [failed]);
  w.fail(); assert.equal(seen.length, 1);
  const {k} = bench(); assert.equal(k.spares.length, 0); k.close();
});

test('pass-on transfers ownerless diagnostics without retaining the old kernel owner', () => {
  const seen: unknown[] = [];
  const k = new RemoteKernel({spares: 0, passOn: true, unownedWorkerFailure: error => seen.push(error), console: {write() {}, read() { return null; }}});
  const w = hand(); k.spares.push(k.adoptWorker(w as unknown as Adopted));
  k.close(); assert.equal((w as unknown as Adopted).kernel, undefined);
  w.fail(); assert.equal(seen.length, 1); assert.equal(w.ended, 1);
  assert.ok(seen[0] instanceof Error); assert.match(seen[0].message, /injected host Worker failure/);
  const {k: next} = bench(); assert.equal(next.spares.length, 0); next.close();
});


test('warm diagnostic preserves adapter-shaped exit and termination-failure messages', () => {
  for (const message of ['CPU Worker exited before a stop request', 'Error: termination rejected']) {
    const w = hand(), delivered: string[] = [];
    // Same serialization used by ricebox's existing failed(error) sender.
    warmThreads({count: 1, failed(error) { delivered.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error)); }}, () => w as unknown as Adopted);
    w.fail(message);
    assert.equal(delivered.length, 1); assert.ok(delivered[0].includes(message));
    assert.ok(!delivered[0].includes('[object Object]')); assert.equal(w.ended, 1);
  }
});

test('detached Worker ownership survives close until its matching observed stop', async () => {
  const {k} = bench(), w = hand() as Hand & {stop: WorkerStop};
  let exit!: (code: number) => void;
  w.stop = new WorkerStop(() => new Promise(() => {}), fn => { exit = fn; });
  w.end = () => { w.ended++; w.stop.request(() => {}); };
  const owners = (k as unknown as {workerOwners: Set<Adopted>}).workerOwners;
  k.spares.push(k.adoptWorker(w as unknown as Adopted));
  k.close();
  assert.equal(k.spares.length, 0); assert.equal(owners.size, 1);
  exit(1); await w.stop.stopped;
  assert.equal(owners.size, 0);
});

test('legacy or browser-like hand with no stop observation remains an owner after request', async () => {
  const {k} = bench(), w = hand();
  const owners = (k as unknown as {workerOwners: Set<Adopted>}).workerOwners;
  k.spares.push(k.adoptWorker(w as unknown as Adopted));
  k.close(); assert.equal(w.ended, 1); assert.equal(owners.size, 1);
  const evidence = await k.snapshotWorkerStops();
  assert.equal(evidence.captured, 1); assert.equal(evidence.observedStopped, 0); assert.equal(evidence.unconfirmed, 1);
});
