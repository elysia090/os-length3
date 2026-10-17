import assert from 'node:assert/strict';
import {test} from 'node:test';
import {inProcessRemote, REMOTE} from './remote.fixture.ts';

// remote.ts as Remote → Devices and a repo's off ask use it, against the Remote itself.
const remote = await inProcessRemote();
const account = await import('./remote.ts');
const {setState} = await import('./state.ts');

/** This browser signed in as `token`. */
const here = (token: string) => setState('remote', JSON.stringify({url: REMOTE, token}));

test('the device list marks this device, first', async () => {
  // Each test is its own account, so no test sees another's sessions.
  const laptop = await remote.signIn('Aoi');
  await remote.signIn('Aoi');
  await here(laptop);
  const list = await account.devices();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((d) => d.current), [true, false]);
});

test('another device is signed out from the list; this one stays', async () => {
  const laptop = await remote.signIn('Ren'), phone = await remote.signIn('Ren');
  await here(laptop);
  const other = (await account.devices()).find((d) => !d.current)!;
  await account.endDevice(other);
  assert.equal(await remote.answers(phone), false);
  assert.equal(await remote.answers(laptop), true);
});

test('this device is never ended from the list: it signs out from the menu', async () => {
  const laptop = await remote.signIn('Mio');
  await here(laptop);
  const self = (await account.devices()).find((d) => d.current)!;
  await assert.rejects(account.endDevice(self), /signs out from your menu/);
  assert.equal(await remote.answers(laptop), true);
});

test('the name the off ask shows is the one the Remote checks', async () => {
  const t = await remote.signIn('Sora Tamura');
  await here(t);
  await remote.repo(t, 'notes');
  await remote.setCode(t, 'AB12C');
  const me = await account.me();
  assert.equal(me?.name, 'Sora Tamura');
  // Just proven (the code was set a moment ago): no passkey is asked again, and a name not the account's is refused.
  await assert.rejects(account.turnOff('notes', 'Sora', 'notes', 'AB12C', true), /The names do not match/);
  const off = await account.turnOff('notes', me!.name, 'notes', 'AB12C', true);
  assert.ok(off.until > off.offAt);
});
