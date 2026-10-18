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

test('signing out from the person menu brings back the way in', async ({signedIn: app}) => {
  await app.me.openMenu();
  await app.me.menu.getByRole('menuitem', {name: 'Sign out'}).click();
  await expect(app.main.getByRole('region', {name: 'Sign in'})).toBeVisible();
  await expect(app.main.getByRole('button', {name: 'Continue with Development'})).toBeVisible();
});
