import {expect, personName, test} from './fixtures.ts';

// Sign in: the first thing a person meets on the Remote, and the way out again.
// Each test here goes through the provider's pages from the card, as a person
// does (`app.signIn`); other specs' `signedIn` is signed in over HTTP.

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
  await app.server.open();
  await expect(app.server.view).toContainText('What answered is not the Remote (200)');
  await expect(app.server.view).not.toContainText('JSON');
  await rail.click();

  answer = 'busy';
  await card.getByRole('button', {name: 'Try again'}).click();
  await expect(card.getByRole('status')).toHaveText('The Remote is not taking requests just now (503)');
  answer = 'ok';
  await card.getByRole('button', {name: 'Try again'}).click();
  await expect(card.getByRole('button', {name: 'Continue with Development'})).toBeVisible();
  await expect(rail).toHaveAccessibleName('Remote');
});

test('signing out from the person menu brings back the way in', async ({app}, info) => {
  await app.signIn(personName(info));
  await app.me.openMenu();
  await app.me.menu.getByRole('menuitem', {name: 'Sign out'}).click();
  await expect(app.main.getByRole('region', {name: 'Sign in'})).toBeVisible();
  await expect(app.main.getByRole('button', {name: 'Continue with Development'})).toBeVisible();
});

test('the first time a provider, a passkey offered right after it; the next time the passkey is the way in', async ({app}, info) => {
  await app.rail.go('remote');
  const card = app.main.getByRole('region', {name: 'Sign in'});
  // The first time, a provider alone: a passkey is made after it.
  await expect(card.getByRole('button', {name: /passkey/})).toHaveCount(0);
  await app.signIn(personName(info));
  // Signed in, and the Remote reached: two things, said apart.
  const standing = app.main.getByRole('status').filter({hasText: 'Signed in as'});
  await expect(standing).toContainText(`Signed in as ${personName(info)}`);
  await expect(standing).toContainText('Connected to');
  // Just back from the provider: a passkey for next time, and one offer only.
  const next = app.main.getByRole('region', {name: 'Add a passkey'});
  await expect(next).toContainText('Next time, sign in with it alone.');
  await expect(app.main.getByRole('button', {name: 'Add a passkey'})).toHaveCount(1);
  await next.getByRole('button', {name: 'Add a passkey'}).click();
  await expect(app.main.getByText('Passkey added', {exact: true})).toBeVisible();
  // Signed out, the passkey is the way in first, the provider under it for a passkey lost.
  await app.me.openMenu();
  await app.me.menu.getByRole('menuitem', {name: 'Sign out'}).click();
  await expect(card.getByRole('button').first()).toHaveText('Sign in with your passkey');
  await expect(card.getByRole('button', {name: 'Continue with Development'})).toBeVisible();
  await card.getByRole('button', {name: 'Sign in with your passkey'}).click();
  await app.settled();
  await expect(app.remote.part('Repos')).toBeVisible();
});

test('a passkey put off for later is offered under the repos instead', async ({app}, info) => {
  await app.signIn(personName(info));
  const next = app.main.getByRole('region', {name: 'Add a passkey'});
  await next.getByRole('button', {name: 'Later'}).click();
  await expect(next).toBeHidden();
  await expect(app.main.getByRole('button', {name: 'Add a passkey'})).toHaveCount(1);
});

test('Cancel at the provider\'s consent comes back to the card, which says so by its name, and it is there to try again', async ({app}, info) => {
  await app.rail.go('remote');
  const card = app.main.getByRole('region', {name: 'Sign in'});
  await card.getByRole('button', {name: 'Continue with Development'}).click();
  await app.page.getByRole('textbox', {name: 'Name'}).fill(personName(info));
  await app.page.getByRole('button', {name: 'Continue'}).click();
  // What length3 asks of the provider, as a real one asks it; called off there.
  await expect(app.page.getByRole('list', {name: 'What length3 asks for'})).toContainText('Know your name and email');
  await app.page.getByRole('button', {name: 'Cancel', exact: true}).click();
  await app.settled();
  await expect(card.getByRole('alert')).toHaveText('Signing in with Development was cancelled; nothing was shared.');
  await expect(card.getByRole('button', {name: 'Continue with Development'})).toBeVisible();
  // Tried again, and allowed: in, and what was said is past.
  await card.getByRole('button', {name: 'Continue with Development'}).click();
  await app.atProvider(personName(info));
  await app.settled();
  await expect(app.remote.part('Repos')).toBeVisible();
});

test('signing in from Inbox comes back to Inbox, signed in', async ({app}, info) => {
  await app.rail.go('inbox');
  await app.main.getByRole('region', {name: 'Sign in'}).getByRole('button', {name: 'Continue with Development'}).click();
  await app.atProvider(personName(info));
  await app.settled();
  await expect(app.rail.button('inbox')).toHaveAttribute('aria-current', 'page');
  await expect(app.main.getByRole('region', {name: 'Sign in'})).toHaveCount(0);
});

test('called off at the provider, the card says so, and the provider is there to try again', async ({app}) => {
  await app.page.goto('/?sign-in-failed&error=access_denied');
  await app.settled();
  const card = app.main.getByRole('region', {name: 'Sign in'});
  await expect(card.getByRole('alert')).toHaveText('Signing in was cancelled at the provider; nothing was shared.');
  await expect(card.getByRole('button', {name: 'Continue with Development'})).toBeVisible();
  // Nothing of the address is shown: its words are anyone's to write.
  await app.page.goto('/?sign-in-failed&error=x&error_description=Your%20account%20is%20locked');
  await app.settled();
  await expect(card).not.toContainText('locked');
});

test('a device\'s code that cannot be used says what that means, and another is typed in its place', async ({signedIn: app}) => {
  await app.page.goto('/?device&user_code=WRONG123');
  await expect(app.page.getByRole('alert')).toHaveText('This code cannot be used.');
  await expect(app.page.getByText('It has run out or was typed wrong')).toBeVisible();
  await expect(app.page.getByText(/invalid_request|expired_token/)).toHaveCount(0);
  await app.page.getByRole('button', {name: 'Type another code'}).click();
  await expect(app.page.getByRole('textbox', {name: 'The device\'s code'})).toBeVisible();
});

test('signed out, the sign-in card stands at one place on Remote and Inbox, wide or narrow, and nothing under it', async ({app}) => {
  await app.newRepo.make('draft');
  const card = app.main.getByRole('region', {name: 'Sign in'});
  // This device's repos are Home's to show: the Remote, signed out, is its way in and nothing more.
  await app.rail.go('remote');
  await expect(card).toBeVisible();
  await expect(app.main.getByText('draft').filter({visible: true})).toHaveCount(0);
  for (const [width, height] of [[1280, 800], [1024, 768], [390, 844]]) {
    await app.page.setViewportSize({width, height});
    const at: Record<string, {x: number; y: number; width: number}> = {};
    for (const place of ['remote', 'inbox'] as const) {
      await app.rail.go(place);
      await expect(card).toBeVisible();
      const box = (await card.boundingBox())!;
      at[place] = {x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width)};
    }
    expect(at.inbox, `${width} wide`).toEqual(at.remote);
  }
});
