import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PidNs, number} from '../../runtime/linux/space.ts';
import {ROOT} from '../../runtime/linux/cred.ts';
import {E, FsError} from '../../runtime/linux/fs.ts';

function spaces() {
  const root = new PidNs(null, ROOT.ns), middle = new PidNs(root, ROOT.ns), leaf = new PidNs(middle, ROOT.ns);
  return {root, middle, leaf};
}
for (const afterSet of [false, true]) test(`failed PID registration removes only this reservation, insertion completed=${afterSet}`, () => {
  const {root, middle, leaf} = spaces(), original = new Error('PID map insertion failed');
  const set = middle.numbers.set.bind(middle.numbers);
  middle.numbers.set = (key, value) => { if (afterSet) set(key, value); throw original; };
  assert.throws(() => number(leaf), error => error === original);
  assert.equal(leaf.numbers.size, 0); assert.equal(middle.numbers.size, 0);
  assert.deepEqual([root.last, middle.last, leaf.last], [1, 1, 1], 'consumed identities are not rewound/reused');
  middle.numbers.set = set;
  assert.throws(() => number(leaf), e => e instanceof FsError && e.errno === E.NOMEM);
  assert.deepEqual([root.last, middle.last, leaf.last], [1, 1, 1]);
});

test('PID cleanup continues after one removal fails and preserves both failures', () => {
  const {middle, leaf} = spaces(), original = new Error('registration failed'), cleanup = new Error('removal failed');
  const set = middle.numbers.set.bind(middle.numbers), del = leaf.numbers.delete.bind(leaf.numbers);
  middle.numbers.set = (key, value) => { set(key, value); throw original; };
  leaf.numbers.delete = key => { del(key); throw cleanup; };
  assert.throws(() => number(leaf), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [original, cleanup]); return true;
  });
  assert.equal(leaf.numbers.size, 0); assert.equal(middle.numbers.size, 0);
});

test('PID cleanup does not remove a replacement owner or an unrelated mapping', () => {
  const {middle, leaf} = spaces(), original = new Error('registration changed ownership');
  leaf.numbers.set(17, 777);
  middle.numbers.set = () => { leaf.numbers.set(1, 999); throw original; };
  assert.throws(() => number(leaf), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], original);
    assert.match(String(error.errors[1]), /ownership/); return true;
  });
  assert.equal(leaf.numbers.get(1), 999); assert.equal(leaf.numbers.get(17), 777);
});

test('PID lookup-read failure does not prevent remaining cleanup', () => {
  const {middle, leaf} = spaces(), original = new Error('registration failed'), cleanup = new Error('lookup failed');
  const set = middle.numbers.set.bind(middle.numbers);
  middle.numbers.set = (key, value) => { set(key, value); throw original; };
  leaf.numbers.get = () => { throw cleanup; };
  assert.throws(() => number(leaf), error => {
    assert.ok(error instanceof AggregateError); assert.deepEqual(error.errors, [original, cleanup]); return true;
  });
  assert.equal(leaf.numbers.size, 1, 'unknown entry remains isolated'); assert.equal(middle.numbers.size, 0);
});

test('PID cleanup never visits an unattempted ancestor', () => {
  const {root, middle, leaf} = spaces(), inner = new PidNs(leaf, ROOT.ns), original = new Error('second insertion refused');
  middle.numbers.set(1, 888);
  leaf.numbers.set = () => { throw original; };
  assert.throws(() => number(inner), error => error === original);
  assert.equal(inner.numbers.size, 0); assert.equal(middle.numbers.get(1), 888);
  assert.equal(root.last, 1);
});

for (const afterSet of [false, true]) test(`outer Kernel PID registration failure cleans its own lookups, inserted=${afterSet}`, async () => {
  const {Kernel, Process} = await import('../../runtime/linux/process.ts');
  const k = new Kernel({console: {write() {}, read: () => null}}), ns = new PidNs(k.spaces.children, ROOT.ns);
  const p = new Process(k, null, false, false, {...k.spaces, children: ns}), original = new Error('outer registration failed');
  const set = k.numbers.set.bind(k.numbers);
  k.numbers.set = (id, record) => { if (afterSet) set(id, record); throw original; };
  assert.throws(() => k.numbered(p), error => error === original);
  assert.equal(k.numbers.size, 0); assert.equal(ns.numbers.size, 0);
  assert.equal(ns.last, 1, 'counter remains consumed');
});

for (const kind of ['replacement', 'outer-delete', 'inner-delete', 'outer-false', 'inner-false'] as const) test(`outer PID failure respects ${kind} ownership uncertainty`, async () => {
  const {Kernel, Process} = await import('../../runtime/linux/process.ts');
  const k = new Kernel({console: {write() {}, read: () => null}}), ns = new PidNs(k.spaces.children, ROOT.ns);
  const p = new Process(k, null, false, false, {...k.spaces, children: ns});
  const original = new Error('outer set failed'), cleanup = new Error('delete refused'), set = k.numbers.set.bind(k.numbers);
  let replacement: Parameters<typeof k.numbers.set>[1] | null = null;
  k.numbers.set = (id, record) => {
    replacement = kind === 'replacement' ? {...record} : record;
    set(id, replacement); throw original;
  };
  if (kind === 'outer-delete') k.numbers.delete = () => { throw cleanup; };
  if (kind === 'inner-delete') ns.numbers.delete = () => { throw cleanup; };
  if (kind === 'outer-false') k.numbers.delete = () => false;
  if (kind === 'inner-false') ns.numbers.delete = () => false;
  assert.throws(() => k.numbered(p), error => {
    assert.ok(error instanceof AggregateError); assert.equal(error.errors[0], original);
    if (kind === 'replacement') assert.match(String(error.errors[1]), /ownership/);
    else if (kind.endsWith('false')) assert.match(String(error.errors[1]), /confirm.*removal/);
    else assert.equal(error.errors[1], cleanup);
    return true;
  });
  assert.equal(ns.numbers.get(1), 1, 'uncertain lookup is retained');
  if (kind === 'inner-delete' || kind === 'inner-false') assert.equal(k.numbers.size, 0);
  else assert.equal(k.numbers.get(1), replacement);
});

test('PID pruning failure removes the new reservation without undoing accepted old pruning', async () => {
  const {Kernel, Process} = await import('../../runtime/linux/process.ts');
  const k = new Kernel({console: {write() {}, read: () => null}}), ns = new PidNs(k.spaces.children, ROOT.ns);
  const p = new Process(k, null, false, false, {...k.spaces, children: ns});
  for (let id = 10; id < 75; id++) k.numbers.set(id, {space: ns, nrs: [id, id]});
  const del = k.numbers.delete.bind(k.numbers), original = new Error('prune failed after removal');
  k.numbers.delete = id => { const result = del(id); if (id === 10) throw original; return result; };
  assert.throws(() => k.numbered(p), error => error === original);
  assert.equal(k.numbers.has(10), false); assert.equal(k.numbers.has(11), true);
  assert.equal(k.numbers.has(1), false); assert.equal(ns.numbers.size, 0);
});

test('first reservation failure in an ancestor rejects a fresh descendant before counters change', () => {
  const {root, middle, leaf} = spaces();
  middle.firstReservationFailed = true;
  const before = [root.last, middle.last, leaf.last];
  assert.throws(() => number(leaf), e => e instanceof FsError && e.errno === E.NOMEM);
  assert.deepEqual([root.last, middle.last, leaf.last], before);
  assert.equal(leaf.numbers.size, 0); assert.equal(root.firstReservationFailed, false);
});

test('failure admission never marks an established init ended or replaces its owner', () => {
  const {root, middle, leaf} = spaces(), original = new Error('registration refused');
  const set = middle.numbers.set.bind(middle.numbers);
  middle.numbers.set = () => { leaf.init = 99; middle.init = 88; throw original; };
  assert.throws(() => number(leaf), e => e === original);
  assert.equal(leaf.firstReservationFailed, true); assert.equal(middle.firstReservationFailed, true);
  assert.deepEqual([leaf.init, middle.init, leaf.ended, middle.ended], [99, 88, false, false]);
  assert.equal(root.firstReservationFailed, false);
  middle.numbers.set = set;
  assert.deepEqual(number(leaf), [2, 2, 2], 'established init owners are not revoked by the failure record');
});

test('lookup cleanup failure still records lost first reservation admission', () => {
  const {root, middle, leaf} = spaces();
  middle.numbers.set = () => { throw new Error('set refused'); };
  leaf.numbers.delete = () => { throw new Error('cleanup refused'); };
  assert.throws(() => number(leaf), AggregateError);
  assert.equal(leaf.firstReservationFailed, true); assert.equal(middle.firstReservationFailed, true);
  assert.equal(root.firstReservationFailed, false);
  const last = [root.last, middle.last, leaf.last];
  assert.throws(() => number(leaf), e => e instanceof FsError && e.errno === E.NOMEM);
  assert.deepEqual([root.last, middle.last, leaf.last], last);
});

for (const mode of ['normal', 'pid2', 'record', 'lookup', 'admission'] as const) test(`initial PID publication checks prepared ownership: ${mode}`, async () => {
  const {publishInitialPid} = await import('../../runtime/linux/space.ts');
  const root = new PidNs(null, ROOT.ns), ns = new PidNs(root, ROOT.ns);
  if (mode === 'pid2') number(ns);
  const nrs = number(ns), id = nrs[0], reservation = {space: ns, nrs}, all = new Map([[id, reservation]]);
  if (mode === 'record') all.set(id, {...reservation});
  if (mode === 'lookup') ns.numbers.set(1, 999);
  if (mode === 'admission') ns.firstReservationFailed = true;
  if (mode === 'normal') { publishInitialPid(ns, id, all, reservation); assert.equal(ns.init, id); }
  else { assert.throws(() => publishInitialPid(ns, id, all, reservation), /PID publication/); assert.equal(ns.init, 0); }
  assert.equal(ns.ended, false);
  if (mode === 'lookup') assert.equal(ns.numbers.get(1), 999);
});

test('prepared PID publication never replaces an established init owner', async () => {
  const {publishInitialPid} = await import('../../runtime/linux/space.ts');
  const root = new PidNs(null, ROOT.ns), ns = new PidNs(root, ROOT.ns), nrs = number(ns);
  const reservation = {space: ns, nrs}, all = new Map([[nrs[0], reservation]]);
  ns.init = 99; ns.firstReservationFailed = true;
  publishInitialPid(ns, nrs[0], all, reservation);
  assert.equal(ns.init, 99); assert.equal(ns.ended, false);
});

for (const ancestor of [false, true]) test(`PID publication refuses an ended namespace, ancestor=${ancestor}`, async () => {
  const {publishInitialPid} = await import('../../runtime/linux/space.ts');
  const {middle, leaf} = spaces(), nrs = number(leaf), record = {space: leaf, nrs}, all = new Map([[nrs[0], record]]);
  leaf.init = 99; middle.init = 88; (ancestor ? middle : leaf).ended = true;
  assert.throws(() => publishInitialPid(leaf, nrs[0], all, record), /ended namespace/);
  assert.equal(leaf.init, 99); assert.equal(middle.init, 88);
});
