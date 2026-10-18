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
  await app.inbox.claim();
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
  await app.server.openLayer();
  await expect(app.server.side.getByRole('button', {name: /^hello/})).toBeVisible();
  await app.server.close();

  await app.rail.go('remote');
  const again = await app.remote.share('hello');
  await again.getByRole('menuitemcheckbox', {name: 'Trip'}).click();
  await expect(again.getByRole('menuitemcheckbox', {name: 'Trip'})).toHaveAttribute('aria-checked', 'false');
});

test('turning a repo off asks in its card first, and Not now leaves it on', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('remote');
  await expect(app.remote.card('hello')).toContainText('In step');

  await app.remote.power('hello').click();
  // With no code set yet, the card says what turning off asks for, and where to set it.
  const card = app.remote.card('hello');
  await expect(card).toContainText('asks for your five-letter code');
  await expect(card.getByRole('button', {name: 'Set the code'})).toBeVisible();
  await expect(app.remote.power('hello')).toBeHidden();

  await card.getByRole('button', {name: 'Not now'}).click();
  await expect(app.remote.power('hello')).toBeChecked();
});
