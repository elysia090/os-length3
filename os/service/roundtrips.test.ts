import assert from 'node:assert/strict';
import {test} from 'node:test';
import {accept, enc, service, upload} from './testing.ts';

// Each statement is a round trip to the database (on Workers, over the WebSocket to Neon), and a transaction is two
// more (its begin and its commit), one after another: a request is as slow as its trips. The routes the app asks
// most, each with the trips it takes: one more is a choice made here, said in review, never one that crept in.
// The first of each is the session (the Worker keeps it a few seconds, request.ts signedIn; a test asks every time).

/** The trips each takes (statements, a transaction's begin and commit among them). */
const BUDGET: Record<string, number> = {
  'poll what moved': 2, 'list repos': 2, 'read a repo': 2, 'upload a blob held': 2,
  // The account's lock, the line with the room and the blobs, the write.
  'save a draft': 6, 'commit': 7, 'history': 3,
  'read a setting': 2, 'change a setting': 2, 'make a setting': 5, 'news': 2,
  'my names': 2, 'conversations': 2, 'one conversation': 4,
  // Who it is from, to, how the two stand; then the lock and the counted write.
  'send a message': 8,
  'servers': 3, 'a board\'s talk': 3, 'post': 6, 'plan': 1, 'standing': 1, 'take signals': 3, 'what is shown': 2,
};

test('each route the app asks most takes the round trips it is given, and no more', async () => {
  const s = await service();
  const pg = (s.db as unknown as {$client: Record<'query' | 'exec' | 'transaction', (...a: never[]) => unknown>}).$client;
  let n = 0;
  const counted = <T extends Record<'query' | 'exec', (...a: never[]) => unknown>>(c: T) => {
    for (const k of ['query', 'exec'] as const) { const f = c[k].bind(c); c[k] = ((...a: never[]) => { n++; return f(...a); }) as T[typeof k]; }
    return c;
  };
  counted(pg as never);
  const begin = pg.transaction.bind(pg) as (f: (tx: never) => unknown) => unknown;
  pg.transaction = ((f: (tx: never) => unknown) => { n += 2; return begin((tx) => f(counted(tx as never) as never)); }) as never;

  const ren = await s.start('Ren'), mio = await s.start('Mio');
  await accept(s, ren, 'mio@length3.test'); await accept(s, mio, 'ren@length3.test');
  const blob = await upload(s, ren, enc.encode('hello'));
  await s.call('PATCH', '/v1/repos/notes/draft', {token: ren, body: {version: 0, set: {'a.txt': blob.sha}, remove: []}});
  const bid = ((await s.call('POST', '/v1/servers', {token: ren, body: {name: 'Trip'}})).json.boards as {id: string}[])[0].id;
  await s.call('GET', '/v1/inbox/me', {token: ren});
  const took: Record<string, number> = {};
  const trips = async (label: string, method: string, path: string, body?: unknown) => {
    n = 0;
    const r = await s.call(method, path, {token: ren, body});
    assert.ok(r.status < 300, `${label}: ${r.status} ${r.text}`);
    took[label] = n;
  };
  await trips('poll what moved', 'GET', '/v1/moved');
  await trips('list repos', 'GET', '/v1/repos');
  await trips('read a repo', 'GET', '/v1/repos/notes');
  const more = await upload(s, ren, enc.encode('more'));
  await trips('upload a blob held', 'PUT', `/v1/blobs/${more.sha}`);
  await trips('save a draft', 'PATCH', '/v1/repos/notes/draft', {version: 1, set: {'b.txt': more.sha}, remove: []});
  await trips('commit', 'POST', '/v1/repos/notes/cuts', {version: 2, parent: null, title: 'first'});
  await trips('history', 'GET', '/v1/repos/notes/log');
  await trips('make a setting', 'PUT', '/v1/home/todo', {value: '[]', version: 0});
  await trips('change a setting', 'PUT', '/v1/home/todo', {value: '[1]', version: 1});
  await trips('read a setting', 'GET', '/v1/home/todo');
  await trips('news', 'GET', '/v1/news');
  await trips('my names', 'GET', '/v1/inbox/me');
  await trips('conversations', 'GET', '/v1/inbox/threads');
  await trips('send a message', 'POST', '/v1/inbox/messages', {to: 'mio', body: 'hi'});
  await trips('one conversation', 'GET', '/v1/inbox/threads/mio@length3.test');
  await trips('servers', 'GET', '/v1/servers');
  await trips('a board\'s talk', 'GET', `/v1/boards/${bid}/posts`);
  await trips('post', 'POST', `/v1/boards/${bid}/posts`, {body: 'hello'});
  await trips('plan', 'GET', '/v1/plan');
  await trips('standing', 'GET', '/v1/standing');
  await trips('take signals', 'POST', '/v1/inbox/signals/take', {from: 'mio@length3.test'});
  await trips('what is shown', 'GET', '/v1/seen');
  assert.deepEqual(took, BUDGET);
});
