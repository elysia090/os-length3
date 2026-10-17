import assert from 'node:assert/strict';
import {test} from 'node:test';
import {forget, furtherThan, isNewBoard, isNewServer, marks, NONE, notTold, type News} from './news.ts';

const board = (id: string, server: string, post: string) => ({id, server, post});
const heard = (inbox: number, ...boards: News['boards']): News => ({inbox, boards});

test('the rail marks Inbox for a message not read, Server for a board with a post not seen', () => {
  assert.deepEqual(marks(NONE), {inbox: false, server: false});
  assert.deepEqual(marks(heard(2)), {inbox: true, server: false});
  assert.deepEqual(marks(heard(0, board('plan', 'trip', '00000000aaaaaaaaa'))), {inbox: false, server: true});
});

test('a board is new, and so is its server\'s chip, while any of its boards is', () => {
  const n = heard(0, board('plan', 'trip', '00000000aaaaaaaaa'), board('read', 'club', '00000000bbbbbbbbb'));
  assert.equal(isNewBoard(n, 'plan'), true);
  assert.equal(isNewBoard(n, 'other'), false);
  assert.equal(isNewServer(n, 'club'), true);
  assert.equal(isNewServer(n, 'work'), false);
});

test('a board seen here is not new at once; the rest stay as they were', () => {
  const n = heard(1, board('plan', 'trip', '00000000aaaaaaaaa'), board('read', 'club', '00000000bbbbbbbbb'));
  assert.deepEqual(forget(n, 'plan'), heard(1, board('read', 'club', '00000000bbbbbbbbb')));
  // Nothing to forget: the same news, so nothing is drawn again.
  assert.equal(forget(n, 'other'), n);
});

test('a look that crossed the telling does not bring back a board read up to its newest; a later post does', () => {
  const told = new Map([['plan', '00000000bbbbbbbbb']]);
  assert.deepEqual(notTold(heard(0, board('plan', 'trip', '00000000bbbbbbbbb')), told).boards, []);
  assert.deepEqual(notTold(heard(0, board('plan', 'trip', '00000000aaaaaaaaa')), told).boards, []);
  assert.deepEqual(notTold(heard(0, board('plan', 'trip', '00000000ccccccccc')), told).boards, [board('plan', 'trip', '00000000ccccccccc')]);
  assert.deepEqual(notTold(heard(0, board('read', 'club', '00000000aaaaaaaaa')), told).boards, [board('read', 'club', '00000000aaaaaaaaa')]);
});

test('reading a board is told the Remote only past what was told, ids sorting as their time', () => {
  const told = new Map([['plan', '00000000bbbbbbbbb']]);
  assert.equal(furtherThan(told, 'plan', '00000000aaaaaaaaa'), false);
  assert.equal(furtherThan(told, 'plan', '00000000bbbbbbbbb'), false);
  assert.equal(furtherThan(told, 'plan', '00000000ccccccccc'), true);
  assert.equal(furtherThan(told, 'read', '00000000aaaaaaaaa'), true);
});
