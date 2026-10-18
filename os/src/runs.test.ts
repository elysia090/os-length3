import assert from 'node:assert/strict';
import {mock, test} from 'node:test';
import {atMost, coalesced, every, shared} from './runs.ts';

/** Let what is waiting on promises go on. */
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

/** A promise and how to answer it, to hold a run in flight. */
function held() {
  let answer!: () => void, refuse!: (e: unknown) => void;
  const p = new Promise<void>((y, n) => { answer = y; refuse = n; });
  return {p, answer, refuse};
}

test('a look every little while never runs twice at once, however slow one is', async () => {
  mock.timers.enable({apis: ['setTimeout']});
  try {
    let running = 0, most = 0, runs = 0;
    const slow = held();
    const loop = every(100, async () => { running++; runs++; most = Math.max(most, running); if (runs === 1) await slow.p; running--; }, {hidden: () => false});
    mock.timers.tick(100);
    await settle();
    // The first is still out: time passing starts no second one.
    mock.timers.tick(1000);
    await settle();
    assert.equal(runs, 1);
    slow.answer();
    await settle();
    mock.timers.tick(100);
    await settle();
    assert.equal(runs, 2);
    assert.equal(most, 1);
    loop.stop();
  } finally { mock.timers.reset(); }
});

test('a look rests while the page is hidden, or goes slower when asked to', async () => {
  mock.timers.enable({apis: ['setTimeout']});
  try {
    let hidden = true, runs = 0;
    const resting = every(100, () => { runs++; }, {hidden: () => hidden});
    mock.timers.tick(1000);
    await settle();
    assert.equal(runs, 0);
    hidden = false;
    mock.timers.tick(100);
    await settle();
    assert.equal(runs, 1);
    resting.stop();

    let slow = 0;
    hidden = true;
    const slower = every(100, () => { slow++; }, {hidden: () => hidden, whileHidden: 1000});
    mock.timers.tick(999);
    await settle();
    assert.equal(slow, 0);
    mock.timers.tick(1);
    await settle();
    assert.equal(slow, 1);
    slower.stop();
  } finally { mock.timers.reset(); }
});

test('a look ends with what it was for, says so once, and a failed step does not end it', async () => {
  mock.timers.enable({apis: ['setTimeout']});
  const quiet = mock.method(console, 'error', () => {});
  try {
    let alive = true, runs = 0, ended = 0;
    every(100, () => { runs++; if (runs === 1) throw new Error('away'); }, {alive: () => alive, ended: () => { ended++; }, hidden: () => false});
    mock.timers.tick(100);
    await settle();
    mock.timers.tick(100);
    await settle();
    assert.equal(runs, 2);
    assert.equal(quiet.mock.callCount(), 1);
    alive = false;
    mock.timers.tick(100);
    await settle();
    mock.timers.tick(1000);
    await settle();
    assert.equal(runs, 2);
    assert.equal(ended, 1);
    const stopped = every(100, () => { runs++; }, {ended: () => { ended++; }, hidden: () => false});
    stopped.stop();
    stopped.stop();
    mock.timers.tick(1000);
    await settle();
    assert.equal(runs, 2);
    assert.equal(ended, 2);
  } finally { mock.timers.reset(); quiet.mock.restore(); }
});

test('asked again while it runs, a deed is done once more after it, never side by side', async () => {
  const gates: ReturnType<typeof held>[] = [];
  const seen: boolean[] = [];
  let running = 0, most = 0;
  const look = coalesced<boolean>(async (mine) => {
    running++; most = Math.max(most, running); seen.push(mine);
    const g = held(); gates.push(g); await g.p;
    running--;
  }, (a, b) => a || b);
  const first = look(false);
  // Three calls while the first runs: one run after it, for all three, and mine if any was.
  const a = look(false), b = look(true), c = look(false);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(gates.length, 1);
  gates[0].answer();
  await first;
  await settle();
  assert.equal(gates.length, 2);
  gates[1].answer();
  await a;
  assert.deepEqual(seen, [false, true]);
  assert.equal(most, 1);
  // Idle again: the next call runs at once.
  const d = look(false);
  assert.equal(gates.length, 3);
  gates[2].answer();
  await d;
});

test('a deed that fails says so to whoever asked for that run, and the run asked for after it still happens', async () => {
  const gates: ReturnType<typeof held>[] = [];
  const look = coalesced(async () => { const g = held(); gates.push(g); await g.p; });
  const first = look();
  const second = look();
  gates[0].refuse(new Error('away'));
  await assert.rejects(first, /away/);
  await settle();
  gates[1].answer();
  await second;
  assert.equal(gates.length, 2);
});

test('a list worked on a few at a time keeps its order and never has more than that many out', async () => {
  let out = 0, most = 0;
  const got = await atMost(3, [5, 1, 4, 2, 3, 0, 6], async (ms) => {
    out++; most = Math.max(most, out);
    await new Promise((r) => setTimeout(r, ms));
    out--;
    return ms * 10;
  });
  assert.deepEqual(got, [50, 10, 40, 20, 30, 0, 60]);
  assert.equal(most, 3);
  assert.deepEqual(await atMost(4, [], async () => 1), []);
});

test('the same deed for the same thing, asked twice at once, is done once', async () => {
  let runs = 0;
  const gate = held();
  const bring = shared(async (repo: string) => { runs++; await gate.p; return repo; });
  const a = bring('trip'), b = bring('trip'), c = bring('notes');
  assert.equal(a, b);
  assert.notEqual(a, c);
  gate.answer();
  assert.deepEqual(await Promise.all([a, b, c]), ['trip', 'trip', 'notes']);
  assert.equal(runs, 2);
  // Done: asked again, it is done again.
  await bring('trip');
  assert.equal(runs, 3);
  // One that failed is not held either.
  const failing = shared(async () => { throw new Error('no'); });
  await assert.rejects(failing('x'), /no/);
  await assert.rejects(failing('x'), /no/);
});
