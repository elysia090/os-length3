import assert from 'node:assert/strict';
import {test} from 'node:test';
import {addByName, dayOf, farFrom, onTop, pageOf, RUN_MS, sameRun, type AddWays, type Post} from './servers.ts';
import {RemoteError} from './remote.ts';

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
  const noon = new Date(2026, 9, 17, 12).getTime();
  assert.equal(dayOf(noon), dayOf(noon + 3600_000));
  assert.notEqual(dayOf(noon), dayOf(noon + 13 * 3600_000));
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

test('someone one knows both ways, by name or code, is in at once and asked nothing', async () => {
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
