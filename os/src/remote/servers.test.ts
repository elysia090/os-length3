import assert from 'node:assert/strict';
import {test} from 'node:test';
import {addByName, dayOf, farFrom, guestBoards, inviteIn, onTop, pageOf, RUN_MS, sameRun, todoKeeper, type AddWays, type BoardTodo, type Post, type TodoWays} from './servers.ts';
import {RemoteError} from './connection.ts';

const post = (id: string): Post => ({id, by: 'ren@length3.test', body: id, at: 0});

test('a page is the range of ids it was read as, newest first', () => {
  assert.equal(pageOf([]), null);
  assert.deepEqual(pageOf(['c', 'b', 'a'].map(post)), {newest: 'c', oldest: 'a', posts: ['c', 'b', 'a'].map(post)});
});

test('what came after, oldest first, goes on top as pages, newest page first and each newest first', () => {
  const came = ['d', 'e', 'f', 'g', 'h'].map(post);
  const pages = onTop(came, 2);
  assert.deepEqual(pages.map((p) => [p.newest, p.oldest]), [['h', 'h'], ['g', 'f'], ['e', 'd']]);
  assert.deepEqual(pages.flatMap((p) => p.posts!.map((q) => q.id)), ['h', 'g', 'f', 'e', 'd']);
});

test('only pages far from every one in view let go of their posts', () => {
  assert.deepEqual(farFrom(20, [], 2), []);
  assert.deepEqual(farFrom(10, [4, 5], 2), [0, 1, 8, 9]);
  assert.deepEqual(farFrom(5, [0], 8), []);
});

test('one address\'s posts close together are one run; a day starts anew', () => {
  const at = (id: string, by: string, ms: number): Post => ({...post(id), by, at: ms});
  const a = at('a', 'ren@x', 0);
  assert.equal(sameRun(undefined, a), false);
  assert.equal(sameRun(a, at('b', 'ren@x', 60_000)), true);
  assert.equal(sameRun(a, at('c', 'aoi@x', 60_000)), false);
  assert.equal(sameRun(a, at('d', 'ren@x', RUN_MS)), false);
  // A guest's posts never run on from one of its people's, whatever they are called.
  const g = {...at('e', 'Aki', 0), guest: true};
  assert.equal(sameRun(g, {...at('f', 'Aki', 60_000), guest: true}), true);
  assert.equal(sameRun(g, at('h', 'Aki', 60_000)), false);
  const noon = new Date(2026, 9, 17, 12).getTime();
  assert.equal(dayOf(noon), dayOf(noon + 3600_000));
  assert.notEqual(dayOf(noon), dayOf(noon + 13 * 3600_000));
});

test('an invitation is read from the link\'s fragment only in its one shape', () => {
  const code = '0123456789abcdef0123456789abcdef';
  assert.deepEqual(inviteIn(`#guest=boardaaaaaaa.${code}`), {board: 'boardaaaaaaa', code});
  assert.deepEqual(inviteIn(`#x=1&guest=boardaaaaaaa.${code}`), {board: 'boardaaaaaaa', code});
  for (const bad of ['', '#guest=', `#guest=BOARDAAAAAAA.${code}`, `#guest=boardaaaaaaa.${code}0`, `#guest=board.${code}`, `#guest=boardaaaaaaa.${code.toUpperCase()}`, `#enter=${code}`]) {
    assert.equal(inviteIn(bad), null, bad);
  }
});

// Adding someone by a name or a code, against a Remote that is a few facts: who has which name,
// whom the server's adding lets in (both accepted), and whether they had accepted one already.
const trip = {id: 'tripaaaaaaaa', name: 'Trip'};
function remote(o: {contacts?: boolean; acceptedMe?: boolean} = {}) {
  const names: Record<string, string> = {mio: 'mio@length3.test', '123456': 'mio@length3.test'};
  const did: string[] = [];
  let both = o.contacts ?? false;
  const ways: AddWays = {
    async lookup(typed) {
      const address = names[typed];
      return address ? {address, reachable: true} : {reachable: false, why: 'No one has that address'};
    },
    async add(server, address) {
      if (!both) throw new RemoteError(403, 'Only your contacts can be added');
      did.push(`add ${server} ${address}`);
    },
    async ask(address, body, server) {
      did.push(`ask ${address} ${server}`);
      assert.match(body, /Trip/);
      // Writing to someone is accepting them: if they had accepted one, the two know each other now.
      if (o.acceptedMe) both = true;
      return {request: !o.acceptedMe};
    },
  };
  return {ways, did};
}

test('someone one knows both ways, by name or code, is in at once and asked nothing (the Remote tells them)', async () => {
  for (const typed of ['mio', ' 123456 ']) {
    const r = remote({contacts: true});
    assert.deepEqual(await addByName(trip, typed, ['ren@length3.test'], r.ways), {address: 'mio@length3.test', is: 'in'});
    assert.deepEqual(r.did, ['add tripaaaaaaaa mio@length3.test']);
  }
});

test('someone not known yet is asked in the Inbox about the server, and waits to accept', async () => {
  const r = remote();
  assert.deepEqual(await addByName(trip, 'mio', [], r.ways), {address: 'mio@length3.test', is: 'asked'});
  assert.deepEqual(r.did, ['ask mio@length3.test tripaaaaaaaa']);
});

test('someone who had accepted one already is in once asked, since writing accepts them back', async () => {
  const r = remote({acceptedMe: true});
  assert.deepEqual(await addByName(trip, 'mio', [], r.ways), {address: 'mio@length3.test', is: 'in'});
  assert.deepEqual(r.did, ['ask mio@length3.test tripaaaaaaaa', 'add tripaaaaaaaa mio@length3.test']);
});

test('someone in it already is said so; a name no one has is the Remote\'s reason, and nothing is sent', async () => {
  const r = remote({contacts: true});
  assert.deepEqual(await addByName(trip, 'mio', ['mio@length3.test'], r.ways), {address: 'mio@length3.test', is: 'already'});
  await assert.rejects(addByName(trip, 'nobody', [], r.ways), /No one has that address/);
  assert.deepEqual(r.did, []);
});

test('the boards this browser writes in as a guest come the one written in last first', () => {
  const shelf = new Map<string, string>();
  const was = (globalThis as {localStorage?: unknown}).localStorage;
  Object.assign(globalThis, {localStorage: {get length() { return shelf.size; }, key: (i: number) => [...shelf.keys()][i] ?? null,
    getItem: (k: string) => shelf.get(k) ?? null, setItem: (k: string, v: string) => void shelf.set(k, v), removeItem: (k: string) => void shelf.delete(k)}});
  try {
    const at = (name: string, wrote?: number) => JSON.stringify({token: 't', as: 'Cy', name, server: 'Trip', ...(wrote ? {wrote} : {})});
    shelf.set('length3.guest.aaa', at('packing', 1));
    shelf.set('length3.other', 'not a guest\'s');
    shelf.set('length3.guest.bbb', at('general', 3));
    shelf.set('length3.guest.ccc', at('food'));
    assert.deepEqual(guestBoards().map((g) => g.id), ['bbb', 'aaa', 'ccc']);
  } finally { Object.assign(globalThis, {localStorage: was}); }
});

// ---- a board's TODO, as the keeper sends it ----

const item = (id: string, title: string, place = 0): BoardTodo => ({id, kind: null, title, detail: '', done: false, repo: null, created: 1, place, by: 'ren'});
/** A Remote's TODO for one board that can be away: `away` refuses as an unreachable Remote does. */
function boardRemote(start: BoardTodo[]) {
  const held = new Map(start.map((x) => [x.id, x]));
  const calls: string[] = [];
  const r = {held, calls, away: false, ways: {} as TodoWays};
  const unreachable = () => new RemoteError(0, 'The Remote cannot be reached');
  r.ways = {
    async put(_board, id, change) {
      calls.push(`put ${id}`);
      if (r.away) throw unreachable();
      const now = {...(held.get(id) ?? item(id, '')), ...change} as BoardTodo;
      held.set(id, now);
      return now;
    },
    async drop(_board, id) {
      calls.push(`drop ${id}`);
      if (r.away) throw unreachable();
      if (!held.delete(id)) throw new RemoteError(404, 'Not found');
    },
  };
  return r;
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test('a TODO change that could not be sent is sent again by itself, and the keeper is not idle until it is', async () => {
  const r = boardRemote([item('a', 'one')]);
  const said: string[] = [];
  const keeper = todoKeeper('b1', [...r.held.values()], {ways: r.ways, pause: 1, backoff: () => 5, trouble: (why) => said.push(why)});
  r.away = true;
  let settled = false;
  const saved = keeper.save([item('a', 'one, changed')]).then(() => { settled = true; });
  for (let i = 0; i < 4; i++) await tick();
  // Away: said, not settled, and not idle, so the board's next look leaves the box alone.
  assert.ok(said.length >= 1);
  assert.equal(said[0], 'The Remote cannot be reached');
  assert.equal(settled, false);
  assert.equal(keeper.idle(), false);
  assert.equal(r.held.get('a')!.title, 'one');
  // Back: the change goes by itself, and the save is answered.
  r.away = false;
  await saved;
  assert.equal(r.held.get('a')!.title, 'one, changed');
  assert.equal(keeper.idle(), true);
});

test('what is written while a try again waits goes in its place, and what failed is not sent over it', async () => {
  const r = boardRemote([item('a', 'one'), item('b', 'two', 1)]);
  const keeper = todoKeeper('b1', [...r.held.values()], {ways: r.ways, pause: 1, backoff: () => 20});
  r.away = true;
  const first = keeper.save([item('a', 'first try')]);
  await tick();
  await tick();
  r.away = false;
  const second = keeper.save([item('a', 'written since'), item('c', 'new', 2)]);
  await Promise.all([first, second]);
  assert.equal(r.held.get('a')!.title, 'written since');
  assert.ok(r.held.has('c'));
  assert.ok(!r.held.has('b'));
});

test('a TODO item already taken off elsewhere is not a failure, and a refusal for good settles the save', async () => {
  const r = boardRemote([item('a', 'one'), item('b', 'two', 1)]);
  const keeper = todoKeeper('b1', [...r.held.values()], {ways: r.ways, pause: 1});
  r.held.delete('b');
  await keeper.save([item('a', 'one')]);
  assert.deepEqual(r.calls, ['drop b']);
  const refused = todoKeeper('b1', [item('a', 'one')], {ways: {...r.ways, put: async () => { throw new RemoteError(403, 'Only its people write here'); }}, pause: 1});
  await assert.rejects(refused.save([item('a', 'mine')]), /Only its people/);
  assert.equal(refused.idle(), true);
});
