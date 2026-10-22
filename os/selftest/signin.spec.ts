import {expect, personName, test} from './fixtures.ts';

// Sign in: the first thing a person meets on the Remote, and the way out again.

test('signing in through a provider shows the Remote as yours, this device among its devices', async ({app}, info) => {
  await app.rail.go('remote');
  await expect(app.main.getByRole('region', {name: 'Sign in'})).toBeVisible();

  await app.signIn(personName(info));

  await expect(app.remote.part('Repos')).toHaveAttribute('aria-selected', 'true');
  await app.remote.part('Devices').click();
  await expect(app.main.getByRole('tabpanel', {name: /^Devices/})).toContainText('This device');
});

test('a Remote that answers with a page or a 503 is said to be away, not to offer nothing, and Try again finds it back', async ({app}) => {
  // As a host's fallback or a gateway answers while the Remote is down: a page, and a 503 with no reply of its own.
  let answer: 'page' | 'busy' | 'ok' = 'page';
  await app.page.route('**/v1/about', (r) => (answer === 'ok' ? r.continue()
    : answer === 'page' ? r.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html><html></html>'})
    : r.fulfill({status: 503, contentType: 'text/plain', body: 'upstream connect error'})));
  await app.page.route('**/v1/open', (r) => (answer === 'ok' ? r.continue() : r.fulfill({status: 200, contentType: 'text/html', body: '<!doctype html>'})));
  await app.open();
  // Away, the rail's Remote is named for it.
  const rail = app.page.getByRole('navigation', {name: 'Purposes'}).getByRole('button', {name: /^(Remote|The Remote cannot be reached)$/});
  await rail.click();
  const card = app.main.getByRole('region', {name: 'Sign in'});
  await expect(card.getByRole('status')).toHaveText('What answered is not the Remote (200)');
  await expect(card).not.toContainText('offers no way');
  await expect(rail).toHaveAccessibleName('The Remote cannot be reached');
  // Server, signed out, reads its open boards from the same Remote: said in words, never the parser's.
  await app.server.openLayer();
  await expect(app.server.layer).toContainText('What answered is not the Remote (200)');
  await expect(app.server.layer).not.toContainText('JSON');
  await app.server.close();

  answer = 'busy';
  await card.getByRole('button', {name: 'Try again'}).click();
  await expect(card.getByRole('status')).toHaveText('The Remote is not taking requests just now (503)');
  answer = 'ok';
  await card.getByRole('button', {name: 'Try again'}).click();
  await expect(card.getByRole('button', {name: 'Continue with Development'})).toBeVisible();
  await expect(rail).toHaveAccessibleName('Remote');
});

test('signing out from the person menu brings back the way in', async ({signedIn: app}) => {
  await app.me.openMenu();
  await app.me.menu.getByRole('menuitem', {name: 'Sign out'}).click();
  await expect(app.main.getByRole('region', {name: 'Sign in'})).toBeVisible();
  await expect(app.main.getByRole('button', {name: 'Continue with Development'})).toBeVisible();
});
