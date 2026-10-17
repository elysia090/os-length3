import assert from 'node:assert/strict';
import {test} from 'node:test';
import {apply, hunks, lines, merge, text, valid} from './plan.ts';

const L = (s: string) => lines(s);

test('an edit goes as hunks of lines, and they make the text again', () => {
  const before = L('goal\n- a\n- b\n- c'), after = L('goal\n- a\n- B\n- c\n- d');
  const hs = hunks(before, after);
  assert.deepEqual(hs, [{at: 2, del: 1, ins: ['- B']}, {at: 4, del: 0, ins: ['- d']}]);
  assert.equal(text(apply(before, hs)), text(after));
  assert.deepEqual(hunks(before, before), []);
  assert.ok(valid(hs, before.length));
  assert.ok(!valid([{at: 3, del: 0, ins: []}, {at: 1, del: 0, ins: []}], 4));
  assert.ok(!valid([{at: 0, del: 9, ins: []}], 4));
  assert.ok(!valid([{at: 0, del: 0, ins: ['two\nlines']}], 4));
});

test('changes in different places both stay; the same lines changed two ways do not merge', () => {
  const base = L('plan\n- one\n- two\n- three');
  const mine = hunks(base, L('plan\n- one!\n- two\n- three'));
  const theirs = hunks(base, L('plan\n- one\n- two\n- three\n- four'));
  assert.equal(text(merge(base, mine, theirs)!), 'plan\n- one!\n- two\n- three\n- four');
  const other = hunks(base, L('plan\n- ONE\n- two\n- three'));
  assert.equal(merge(base, mine, other), null);
  // The same change made on both sides is taken once.
  assert.equal(text(merge(base, mine, mine)!), 'plan\n- one!\n- two\n- three');
  // Two insertions at the same place cannot be ordered: not merged.
  assert.equal(merge(base, [{at: 4, del: 0, ins: ['a']}], [{at: 4, del: 0, ins: ['b']}]), null);
});
