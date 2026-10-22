import assert from 'node:assert/strict';
import {test} from 'node:test';
import {differs, Held} from './conflict.ts';

test('a text saved elsewhere comes in at once while nothing here is unsaved', () => {
  const h = new Held('one\n');
  assert.equal(h.came('two\n', 'one\n'), 'take');
  assert.equal(h.saved, 'two\n');
  assert.ok(h.canSave);
  // The same text as here is no news, whatever was saved.
  assert.equal(h.came('mine\n', 'mine\n'), 'same');
  assert.equal(h.saved, 'mine\n');
});

test('while something here is unsaved it is asked, and saving waits for the answer', () => {
  const h = new Held('one\n');
  assert.equal(h.came('theirs\n', 'mine\n'), 'ask');
  assert.equal(h.theirs, 'theirs\n');
  assert.ok(!h.canSave);
  // A newer text of theirs keeps it asked, with the newest.
  assert.equal(h.came('theirs again\n', 'mine\n'), 'ask');
  assert.equal(h.theirs, 'theirs again\n');
  // Even when the editor is back at what was saved, theirs is not taken without asking.
  assert.equal(h.came('theirs, third\n', 'one\n'), 'ask');
});

test('taking the other text shows it and writes nothing; saving mine writes mine over it', () => {
  const take = new Held('one\n');
  take.came('theirs\n', 'mine\n');
  assert.equal(take.useTheirs(), 'theirs\n');
  assert.deepEqual([take.saved, take.theirs, take.canSave], ['theirs\n', null, true]);

  const keep = new Held('one\n');
  keep.came('theirs\n', 'mine\n');
  const write = keep.keepMine('mine\n');
  assert.equal(write, 'mine\n');
  assert.ok(keep.canSave);
  keep.wrote(write);
  assert.equal(keep.saved, 'mine\n');
  // Afterwards a new text from elsewhere comes in as before.
  assert.equal(keep.came('later\n', 'mine\n'), 'take');
});

test('writing on until mine is theirs ends the ask', () => {
  const h = new Held('a\n');
  h.came('b\n', 'c\n');
  assert.equal(h.typed('c, more\n'), false);
  assert.equal(h.typed('b\n'), true);
  assert.deepEqual([h.saved, h.asking], ['b\n', false]);
});

test('what differs reads as what saving mine would do to theirs', () => {
  const d = differs('a\nb\nc\n', 'a\nB\nc\nd\n');
  assert.deepEqual([d.added, d.removed], [2, 1]);
  assert.deepEqual(d.lines.map((l) => `${l.kind} ${l.text}`), ['same a', 'del b', 'add B', 'same c', 'add d']);
});
