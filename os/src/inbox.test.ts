import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Conversation, type Message, type Thread} from './inbox.ts';

const message = (id: string, time: number, mine = false): Message => ({id, mine, type: 'message', target: {}, body: id, time, read: false});
const row = (time: number): Thread => ({address: 'mio@length3.test', name: 'Mio', state: 'contact', unread: 0, last: {type: 'message', body: '', mine: false, time}});
const ids = (list: Message[]) => list.map((m) => m.id);

test('what the Remote gives an open conversation is taken in once, in its order', () => {
  const c = new Conversation();
  assert.deepEqual(ids(c.took([message('a', 10), message('b', 20)])), ['a', 'b']);
  // The next look gives the whole conversation again: only what came is new.
  assert.deepEqual(ids(c.took([message('a', 10), message('b', 20), message('c', 30)])), ['c']);
  assert.deepEqual(ids(c.took([message('a', 10), message('b', 20), message('c', 30)])), []);
});

test('a message added here (sent, or over the direct line) is not drawn again when the Remote gives it', () => {
  const c = new Conversation();
  c.took([message('a', 10)]);
  assert.equal(c.have(message('mine', 15, true)), true);
  assert.equal(c.have(message('mine', 15, true)), false);
  assert.deepEqual(ids(c.took([message('a', 10), message('mine', 12, true), message('reply', 40)])), ['reply']);
});

test('the list\'s row says when there is more to take in, by the Remote\'s clock, not this device\'s', () => {
  const c = new Conversation();
  c.took([message('a', 100)]);
  assert.equal(c.behind(row(100)), false);
  assert.equal(c.behind(row(101)), true);
  // Sent here with a clock running ahead: a reply the Remote stamps earlier than it is still looked for.
  c.have(message('mine', 9_999, true));
  assert.equal(c.behind(row(150)), true);
  c.took([message('a', 100), message('reply', 150)]);
  assert.equal(c.behind(row(150)), false);
});
