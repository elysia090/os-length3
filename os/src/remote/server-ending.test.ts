import assert from 'node:assert/strict';
import {test} from 'node:test';
import {inProcessRemote, REMOTE} from '../testing/remote-fixture.ts';

// What Server's gear says leaving and removing a server come to (servers.ending) is what the Remote
// then does: how long it is held, and who owns it after its owner leaves. Against the Remote itself.
const remote = await inProcessRemote();
const servers = await import('./servers.ts');
const inbox = await import('./inbox.ts');
const {setState} = await import('../home/state.ts');
const schema = await import('../../service/schema.ts');
const {HOLD} = await import('../../service/names.ts');
const {SERVER} = await import('../../service/servers.ts');

const DAY = 86_400_000;
const as = (token: string) => setState('remote', JSON.stringify({url: REMOTE, token}));
/** Someone signed in with a name of their own on this Remote; `id` their account. */
async function person(name: string) {
  const token = await remote.signIn(name);
  await as(token);
  await inbox.claim(name.toLowerCase());
  const {user} = await (await fetch(`${REMOTE}/api/auth/get-session`, {headers: {Authorization: `Bearer ${token}`}})).json() as {user: {id: string}};
  const {addresses} = await inbox.me();
  return {token, id: user.id, address: addresses[0].address};
}
/** `who` in server `id`, as if added (the Inbox's both-ways accepting is tested in servers.test.ts and the selftest). */
const join = (id: string, who: {id: string}) => remote.db.insert(schema.member).values({serverId: id, userId: who.id});
const near = (ms: number, want: number) => assert.ok(Math.abs(ms - want) < 60_000, `${ms} is not about ${want}`);
const mine = async (id: string) => (await servers.servers()).find((s) => s.id === id)!;

test('the held times the gear says are the Remote\'s own', () => {
  assert.equal(servers.HELD, HOLD);
  assert.equal(servers.HELD_ALONE, SERVER.alone);
});

test('its maker alone: removing holds it a day, and so does leaving, the last one out', async () => {
  const ada = await person('Ada');
  for (const how of ['remove', 'leave'] as const) {
    const s = await servers.makeServer(`Solo ${how}`, `solo-${how}`);
    const said = servers.ending(await mine(s.id), await servers.people(s.id), ada.address);
    assert.equal(said.last, true);
    assert.equal(said.heir, null);
    assert.equal(said[how], DAY);
    if (how === 'remove') near((await servers.removeServer(s.id)).until - Date.now(), said.remove);
    else await servers.removePerson(s.id, ada.address);
    const held = (await servers.goneServers()).find((g) => g.id === s.id)!;
    near(held.until - Date.now(), said[how]);
  }
});

test('with others in it: removing holds it 30 days, and its owner leaving hands it to whoever came in first after', async () => {
  const ada = await person('Aoi'), bo = await person('Bo'), cy = await person('Cy');
  await as(ada.token);
  const s = await servers.makeServer('Trip', 'trip-aoi');
  await join(s.id, bo);
  await join(s.id, cy);
  const said = servers.ending(await mine(s.id), await servers.people(s.id), ada.address);
  assert.equal(said.last, false);
  assert.equal(said.heir, bo.address);
  assert.equal(said.remove, HOLD);
  await servers.removePerson(s.id, ada.address);
  await as(bo.token);
  assert.equal((await mine(s.id)).owner, true);
  await as(cy.token);
  assert.equal((await mine(s.id)).owner, false);

  // Removed by an owner who did not make it, with others still in it: 30 days.
  await as(bo.token);
  const r = servers.ending(await mine(s.id), await servers.people(s.id), bo.address);
  assert.equal(r.remove, HOLD);
  near((await servers.removeServer(s.id)).until - Date.now(), r.remove);
});

test('the last one out who did not make it: it goes, held 30 days', async () => {
  const ada = await person('Mio'), bo = await person('Ren');
  await as(ada.token);
  const s = await servers.makeServer('Books', 'books-mio');
  await join(s.id, bo);
  await servers.removePerson(s.id, ada.address);
  await as(bo.token);
  const said = servers.ending(await mine(s.id), await servers.people(s.id), bo.address);
  assert.equal(said.last, true);
  assert.equal(said.heir, null);
  assert.equal(said.leave, HOLD);
  await servers.removePerson(s.id, bo.address);
  near((await servers.goneServers()).find((g) => g.id === s.id)!.until - Date.now(), said.leave);
});
