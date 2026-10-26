import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Drafts} from './drafts.ts';

test('a draft stays with what it was written for, and is not carried to another', () => {
  const d = new Drafts();
  d.set('mio@length3.test', 'Half a mess');
  d.set('board:plan', 'Half a post');
  assert.equal(d.get('mio@length3.test'), 'Half a mess');
  assert.equal(d.get('board:plan'), 'Half a post');
  assert.equal(d.get('kai@length3.test'), '');
});

test('a draft goes only when sent, or when everything written is taken out', () => {
  const d = new Drafts();
  d.set('a', 'words');
  d.sent('a');
  assert.equal(d.get('a'), '');
  d.set('b', 'words');
  d.set('b', '');
  assert.equal(d.get('b'), '');
});

test('a draft holds words only when there are more than spaces, though its spaces are kept as written', () => {
  const d = new Drafts();
  d.set('a', '  \n');
  assert.equal(d.holds('a'), false);
  assert.equal(d.get('a'), '  \n');
  d.set('a', ' x');
  assert.equal(d.holds('a'), true);
  assert.equal(d.holds('nothing'), false);
});
