import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Conversation, liveMessage, placeOf, type Message, type Thread} from './inbox.ts';

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

test('what comes over the direct line is taken only as the Remote would take a message, and never as one\'s own', () => {
  const said = (m: unknown) => liveMessage(JSON.stringify(m));
  const ok = said({id: 'a1', type: 'review', target: {repo: 'trip', change: 'c0ffee'}, body: '  look  ', time: 5, mine: true, read: true});
  assert.deepEqual(ok, {id: 'a1', mine: false, type: 'review', target: {repo: 'trip', change: 'c0ffee'}, body: 'look', time: 5, read: false, live: true});
  // Not a message: dropped, not drawn as one.
  for (const bad of ['not json', '[1]', 'null', JSON.stringify({id: 'a', body: ''}), JSON.stringify({body: 'no id'}),
    JSON.stringify({id: 7, body: 'x'}), JSON.stringify({id: 'a', body: 'x'.repeat(4001)}), JSON.stringify({id: 'a'.repeat(65), body: 'x'})]) {
    assert.equal(liveMessage(bad), null, bad);
  }
  assert.equal(liveMessage(42), null);
  // A kind it does not know is a plain message; keys and values the Remote would not keep are not kept.
  const odd = said({id: 'b', type: 'admin', body: 'x', target: {repo: 'r', evil: 'y', issue: {length: 1}, version: 2, server: 'x'.repeat(201)}});
  assert.equal(odd?.type, 'message');
  assert.deepEqual(odd?.target, {repo: 'r', version: 2});
  // A clock ahead of this one's, or none, is now.
  const later = said({id: 'c', body: 'x', time: Date.now() + 86_400_000});
  assert.ok(later && later.time <= Date.now());
  assert.ok((said({id: 'd', body: 'x', time: 'soon'})?.time ?? 0) > 0);
});

test('a message leads somewhere only when it names a repo and an issue as they can be here', () => {
  assert.deepEqual(placeOf({repo: 'trip'}), {repo: 'trip'});
  assert.deepEqual(placeOf({repo: 'trip', issue: '001.md'}), {repo: 'trip', issue: '001.md'});
  assert.equal(placeOf({}), null);
  assert.equal(placeOf({server: 's1'}), null);
  // Anyone may write any short string there: a path out of the repo, or out of issue/, leads nowhere.
  for (const t of [{repo: '../etc'}, {repo: '.git'}, {repo: 'a/b'}, {repo: ''}, {repo: 'x'.repeat(65)},
    {repo: 'trip', issue: '../../.git/config'}, {repo: 'trip', issue: 'sub/001.md'}, {repo: 'trip', issue: '.hidden.md'}, {repo: 'trip', issue: '001.txt'}]) {
    assert.equal(placeOf(t), null, JSON.stringify(t));
  }
  assert.equal(placeOf({repo: 7 as unknown as string}), null);
});
