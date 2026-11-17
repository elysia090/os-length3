import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PidNs, number} from '../../runtime/linux/space.ts';
import {ROOT} from '../../runtime/linux/cred.ts';

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
  assert.deepEqual(number(leaf), [2, 2, 2]);
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
