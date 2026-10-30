import {expect, test} from './fixtures.ts';

// Remote, signed in: each repo the Remote holds as a card (where it stands,
// Forge, Share, its power switch). Share lists one's servers and shows the
// repo in one at a press; turning a repo off asks in the card first.

test('a repo made here is a card on the Remote, in step, its switch on', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('remote');

  const card = app.remote.card('hello');
  await expect(card).toContainText('In step');
  await expect(card.getByRole('button', {name: 'Forge', exact: true})).toBeEnabled();
  await expect(app.remote.power('hello')).toBeChecked();
  await expect(app.remote.power('hello')).toHaveAccessibleName('Turn hello off');
});

test('Share shows the repo in a server at a press, and takes it off at the next', async ({signedIn: app}) => {
  await app.server.make('Trip', `${app.handle}-trip`);
  await app.server.close();
  await app.newRepo.make('hello');
  await app.rail.go('remote');
  await expect(app.remote.card('hello')).toContainText('In step');

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
  await expect(app.remote.card('hello')).toContainText('In step');
  const list = await app.remote.share('hello');
  await expect(list).toContainText('In no server yet');
  await list.getByRole('menuitem', {name: 'Make a server…'}).click();
  await expect(app.server.view.getByRole('textbox', {name: 'Name', exact: true})).toBeVisible();
});

test('Share in no server yet on the free plan says making one is paid, and leads to the plan', async ({planSignedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('remote');
  await expect(app.remote.card('hello')).toContainText('In step');
  const list = await app.remote.share('hello');
  await expect(list).toContainText('Making a server is part of the paid plan.');
  await list.getByRole('menuitem', {name: 'See the plan'}).click();
  await expect(app.remote.part('Plan')).toHaveAttribute('aria-selected', 'true');
});

test('turning a repo off asks in its card first, and Not now leaves it on', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('remote');
  await expect(app.remote.card('hello')).toContainText('In step');

  await app.remote.power('hello').click();
  // With no code yet, the card asks for one right there (a passkey confirms it), then for the names.
  const ask = app.remote.ask('hello');
  await expect(ask).toContainText('This asks for a five-letter code of your own.');
  await expect(ask.getByRole('textbox', {name: 'New code'})).toBeFocused();
  await expect(ask.getByRole('button', {name: 'Set the code'})).toBeVisible();
  await expect(app.remote.power('hello')).toBeHidden();

  await ask.getByRole('button', {name: 'Not now'}).click();
  await expect(app.remote.power('hello')).toBeChecked();
});

test('a repo is turned off from its card in one ask, kept off, and its switch brings it back', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('remote');
  await expect(app.remote.card('hello')).toContainText('In step');

  await app.remote.turnOff('hello', 'k3y42');

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
  await expect(card).toContainText('In step');
});

test('opened by the app at a repo, the browser asks at its card, and once it is off says to go back to the app', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('remote');
  await expect(app.remote.card('hello')).toContainText('In step');

  // The app opens this, where the passkey is (core account::app_page): the ask taken out of the address, Remote's
  // Repos shown, and the card's own ask pressed for the person.
  await app.page.goto('/?account=off&repo=hello');
  const ask = app.remote.ask('hello');
  await expect(ask).toContainText('This asks for a five-letter code of your own.');
  expect(new URL(app.page.url()).search).toBe('');
  const fresh = ask.getByRole('textbox', {name: 'New code'});
  await fresh.fill('k3y42');
  await app.answer(ask.getByRole('button', {name: 'Set the code'}), fresh);
  await ask.getByRole('textbox', {name: 'Your name'}).fill(app.person);
  await ask.getByRole('textbox', {name: 'The repo\'s name'}).fill('hello');
  await ask.getByRole('textbox', {name: 'Code', exact: true}).fill('k3y42');
  await app.answer(ask.getByRole('button', {name: 'Turn off'}), ask);

  await expect(app.remote.power('hello')).not.toBeChecked();
  await expect(app.main.getByRole('status').filter({hasText: 'Done. Go back to the app: it shows it there.'})).toBeVisible();
});

test('opened by the app at a repo this account does not have, the browser says so and asks nothing', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.page.goto('/?account=off&repo=elsewhere');
  await expect(app.main.getByRole('status').filter({hasText: 'elsewhere is not on here to turn off'})).toBeVisible();
  await expect(app.remote.power('hello')).toBeChecked();
});

test('a code that is wrong does not turn the repo off, and says so in the card', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('remote');
  await expect(app.remote.card('hello')).toContainText('In step');
  // The code is set once (on the way to turning something off), then asked for each time.
  await app.remote.turnOff('hello', 'k3y42');
  await app.remote.power('hello').click();
  await expect(app.remote.power('hello')).toBeChecked();

  await app.remote.power('hello').click();
  const ask = app.remote.ask('hello');
  // Set already: straight to the names, once.
  await expect(ask.getByRole('textbox', {name: 'Your name'})).toBeFocused();
  await expect(ask.getByRole('textbox', {name: 'New code'})).toHaveCount(0);
  await ask.getByRole('textbox', {name: 'Your name'}).fill(app.person);
  await ask.getByRole('textbox', {name: 'The repo\'s name'}).fill('hello');
  await ask.getByRole('textbox', {name: 'Code', exact: true}).fill('wrong');
  const off = ask.getByRole('button', {name: 'Turn off'});
  await expect(async () => {
    await off.click({timeout: 1000});
    await expect(ask.getByRole('alert')).not.toBeEmpty({timeout: 1000});
  }).toPass({timeout: 15_000});
  await expect(ask.getByRole('alert')).toHaveText('That is not the code.');

  await ask.getByRole('button', {name: 'Not now'}).click();
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
  await devices.getByRole('button', {name: 'Connect a device'}).click();
  const ask = devices.getByRole('group', {name: 'Connect a device'});
  const code = ask.getByRole('textbox', {name: 'The device\'s code'});
  await expect(code).toBeFocused();
  await code.fill(user_code);
  await code.press('Enter');
  await expect(ask).toContainText('l3 (the command line) asks to join this account.');
  await expect(ask.getByRole('button', {name: 'Not now'})).toBeHidden();
  await ask.getByRole('button', {name: 'Connect', exact: true}).click();
  await expect(ask).toContainText('Connected. Go back to the device.');
  // The device takes its session, and comes in among the devices, to be signed out from its row as any other.
  const token = await l3.post('/api/auth/device/token', {data: {grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code, client_id: 'l3'}});
  expect(token.ok(), await token.text()).toBe(true);
  await expect(devices.getByRole('button', {name: /^Sign out /})).toHaveCount(1, {timeout: 15_000});
  await ask.getByRole('button', {name: 'Done'}).click();
  await expect(devices.getByRole('button', {name: 'Connect a device'})).toBeFocused();
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
  await expect(ask).toContainText('It is signed out at once.');
  await app.answer(ask.getByRole('button', {name: 'Sign out', exact: true}), ask);
  await expect(devices.getByRole('button', {name: /^Sign out /})).toHaveCount(0);

  await laptop.rail.go('home');
  await laptop.rail.go('remote');
  await expect(laptop.main.getByRole('region', {name: 'Sign in'})).toBeVisible();
});
