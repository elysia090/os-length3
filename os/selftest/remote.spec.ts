import {expect, test} from './fixtures.ts';

// Remote, signed in: each repo the Remote holds as a card (where it stands,
// Forge, Share, its power switch). Share lists one's servers and shows the
// repo in one at a press; turning a repo off asks in the card first.

test('a repo made here is a card on the Remote, in step, its switch on', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('remote');

  const card = app.remote.card('hello');
  await expect(card).toContainText('Synced');
  await expect(card.getByRole('button', {name: 'Forge', exact: true})).toBeEnabled();
  await expect(app.remote.power('hello')).toBeChecked();
  await expect(app.remote.power('hello')).toHaveAccessibleName('Turn hello off');
});

test('Share shows the repo in a server at a press, and takes it off at the next', async ({signedIn: app}) => {
  await app.server.make('Trip', `${app.handle}-trip`);
  await app.server.close();
  await app.newRepo.make('hello');
  await app.rail.go('remote');
  await expect(app.remote.card('hello')).toContainText('Synced');

  const list = await app.remote.share('hello');
  const trip = list.getByRole('menuitemcheckbox', {name: 'Trip'});
  await expect(trip).toHaveAttribute('aria-checked', 'false');
  await trip.click();
  await expect(trip).toHaveAttribute('aria-checked', 'true');
  // The list stays for the next; the server's people now see it.
  await app.page.keyboard.press('Escape');
  await expect(list).toBeHidden();
  await app.server.open();
  await expect(app.server.side.getByRole('button', {name: /^hello/})).toBeVisible();
  await app.server.close();

  await app.rail.go('remote');
  const again = await app.remote.share('hello');
  await again.getByRole('menuitemcheckbox', {name: 'Trip'}).click();
  await expect(again.getByRole('menuitemcheckbox', {name: 'Trip'})).toHaveAttribute('aria-checked', 'false');
});

test('Share in no server yet leads on to making one', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('remote');
  await expect(app.remote.card('hello')).toContainText('Synced');
  const list = await app.remote.share('hello');
  await expect(list).toContainText('Not a member of any server');
  await list.getByRole('menuitem', {name: 'Create server…'}).click();
  await expect(app.server.view.getByRole('textbox', {name: 'Name', exact: true})).toBeVisible();
});

test('Share in no server yet on the free plan says making one is paid, and leads to the plan', async ({planSignedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('remote');
  await expect(app.remote.card('hello')).toContainText('Synced');
  const list = await app.remote.share('hello');
  await expect(list).toContainText('Server creation requires a paid plan.');
  await list.getByRole('menuitem', {name: 'View plan'}).click();
  await expect(app.remote.part('Plan')).toHaveAttribute('aria-selected', 'true');
});

test('turning a repo off asks in its card first, for its name, and Not now leaves it on', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('remote');
  await expect(app.remote.card('hello')).toContainText('Synced');

  await app.remote.power('hello').click();
  // Its name written out, then a passkey: nothing of the account's to set or keep in mind first.
  const ask = app.remote.ask('hello');
  await expect(ask).toContainText('To confirm, type hello.');
  await expect(ask.getByRole('textbox', {name: 'Repo name'})).toBeFocused();
  await expect(ask.getByRole('textbox')).toHaveCount(1);
  await expect(app.remote.power('hello')).toBeHidden();

  await ask.getByRole('button', {name: 'Cancel'}).click();
  await expect(app.remote.power('hello')).toBeChecked();
});

test('a repo is turned off from its card in one ask, kept off, and its switch brings it back', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('remote');
  await expect(app.remote.card('hello')).toContainText('Synced');

  await app.remote.turnOff('hello');

  const card = app.remote.card('hello');
  await expect(card).toContainText(/Off · back until /);
  await expect(app.remote.power('hello')).not.toBeChecked();
  await expect(app.remote.power('hello')).toHaveAccessibleName('Turn hello on');
  // Off, Forge is what frees the copy here, and Discard is beside it.
  await expect(card.getByRole('button', {name: 'Free'})).toBeVisible();
  await expect(card.getByRole('button', {name: 'Discard'})).toBeVisible();

  // On again at once, with no ask.
  await app.remote.power('hello').click();
  await expect(app.remote.power('hello')).toBeChecked();
  await expect(card).toContainText('Synced');
});

test('opened by the app at a repo, the browser asks at its card, and once it is off says to go back to the app', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('remote');
  await expect(app.remote.card('hello')).toContainText('Synced');

  // The app opens this, where the passkey is (core account::app_page): the ask taken out of the address, Remote's
  // Repos shown, and the card's own ask pressed for the person.
  await app.page.goto('/?account=off&repo=hello');
  const ask = app.remote.ask('hello');
  await expect(ask.getByRole('textbox', {name: 'Repo name'})).toBeFocused();
  expect(new URL(app.page.url()).search).toBe('');
  await ask.getByRole('textbox', {name: 'Repo name'}).fill('hello');
  await app.answer(ask.getByRole('button', {name: 'Disable'}), ask);

  await expect(app.remote.power('hello')).not.toBeChecked();
  await expect(app.main.getByRole('status').filter({hasText: 'Done. Return to the app to view changes.'})).toBeVisible();
});

test('opened by the app at a repo this account does not have, the browser says so and asks nothing', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.page.goto('/?account=off&repo=elsewhere');
  await expect(app.main.getByRole('status').filter({hasText: 'elsewhere is not on here to turn off'})).toBeVisible();
  await expect(app.remote.power('hello')).toBeChecked();
});

test('a name not written as the repo\'s does not turn it off, and says so in the card, before any passkey', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('remote');
  await expect(app.remote.card('hello')).toContainText('Synced');

  await app.remote.power('hello').click();
  const ask = app.remote.ask('hello');
  await ask.getByRole('textbox', {name: 'Repo name'}).fill('Hello');
  const off = ask.getByRole('button', {name: 'Disable'});
  await expect(async () => {
    await off.click({timeout: 1000});
    await expect(ask.getByRole('alert')).not.toBeEmpty({timeout: 1000});
  }).toPass({timeout: 15_000});
  await expect(ask.getByRole('alert')).toHaveText('Type hello as it is written.');
  await expect(ask.getByRole('textbox', {name: 'Repo name'})).toBeFocused();

  await ask.getByRole('button', {name: 'Cancel'}).click();
  await expect(app.remote.power('hello')).toBeChecked();
});

test("a device's code is typed in Devices, and the device let in there as on the code's own page", async ({signedIn: app, playwright}) => {
  // l3 asks the Remote to join, as `l3 remote login` does (a client of its own, no browser's cookies), and shows its code.
  const l3 = await playwright.request.newContext({baseURL: process.env.SELFTEST_REMOTE});
  const asked = await l3.post('/api/auth/device/code', {data: {client_id: 'l3'}});
  expect(asked.ok(), await asked.text()).toBe(true);
  const {device_code, user_code} = await asked.json() as {device_code: string; user_code: string};
  await app.rail.go('remote');
  await app.remote.part('Devices').click();
  const devices = app.main.getByRole('tabpanel', {name: /^Devices/});
  // At the list's foot, room for the next one, and the way to it.
  await devices.getByRole('button', {name: 'Connect device'}).click();
  const ask = devices.getByRole('group', {name: 'Connect device'});
  const code = ask.getByRole('textbox', {name: 'Device pairing code'});
  await expect(code).toBeFocused();
  await code.fill(user_code);
  await code.press('Enter');
  await expect(ask).toContainText('l3 (CLI) asks to join this account.');
  await expect(ask.getByRole('button', {name: 'Cancel'})).toBeHidden();
  await ask.getByRole('button', {name: 'Connect', exact: true}).click();
  await expect(ask).toContainText('Connected. Return to your device.');
  // The device takes its session, and comes in among the devices, to be signed out from its row as any other.
  const token = await l3.post('/api/auth/device/token', {data: {grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code, client_id: 'l3'}});
  expect(token.ok(), await token.text()).toBe(true);
  await expect(devices.getByRole('button', {name: /^Sign out /})).toHaveCount(1, {timeout: 15_000});
  await ask.getByRole('button', {name: 'Done'}).click();
  await expect(devices.getByRole('button', {name: 'Connect device'})).toBeFocused();
  await l3.dispose();
});

test('another device of yours is signed out from Devices, and finds itself signed out', async ({signedIn: app, another}) => {
  // The same person in a second browser: another device of the same account.
  const laptop = await another('Ada');
  // Its devices are read as Remote is drawn: drawn again, the laptop is among them.
  await app.rail.go('home');
  await app.rail.go('remote');
  await app.remote.part('Devices').click();
  const devices = app.main.getByRole('tabpanel', {name: /^Devices/});
  // This device has nothing to press; the other is signed out from its row.
  const out = devices.getByRole('button', {name: /^Sign out /});
  await expect(out).toHaveCount(1);
  const which = (await out.getAttribute('aria-label'))!;

  await out.click();
  const ask = devices.getByRole('group', {name: which, exact: true});
  await expect(ask).toContainText('Signed out immediately.');
  await app.answer(ask.getByRole('button', {name: 'Sign out', exact: true}), ask);
  await expect(devices.getByRole('button', {name: /^Sign out /})).toHaveCount(0);

  await laptop.rail.go('home');
  await laptop.rail.go('remote');
  await expect(laptop.main.getByRole('region', {name: 'Sign in'})).toBeVisible();
});
