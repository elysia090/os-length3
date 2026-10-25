import type {Locator} from '@playwright/test';
import {expect, test} from './fixtures.ts';

// Runtime: dotfiles are small cards (name, size); a dotfile saved is one,
// opens with its text, and is still there when the app is opened again.
// Remove asks in the box first, since it goes from every device.

test('a dotfile saved shows as a card, opens with its text, and stays', async ({app}) => {
  await app.runtime.makeDotfile('.profile', 'export EDITOR=vi\n');

  await expect(app.runtime.dotfile('.profile')).toContainText('17 B');

  await app.open();
  await app.runtime.open('Dotfiles');
  await app.runtime.dotfile('.profile').click();
  await expect(app.runtime.text('.profile')).toHaveValue('export EDITOR=vi\n');
});

test('removing a dotfile asks in its box: Not now keeps it, Remove takes it', async ({app}) => {
  await app.runtime.makeDotfile('.profile', 'export EDITOR=vi\n');
  await app.runtime.dotfile('.profile').click();

  const ask = await app.runtime.askRemove('.profile');
  await expect(ask).toContainText('.profile goes from every device.');
  await ask.getByRole('button', {name: 'Not now'}).click();
  await expect(ask).toBeHidden();
  await expect(app.runtime.text('.profile')).toHaveValue('export EDITOR=vi\n');

  const again = await app.runtime.askRemove('.profile');
  await app.answer(again.getByRole('button', {name: 'Remove', exact: true}), again);
  await expect(app.runtime.dotfile('.profile')).toHaveCount(0);

  await app.open();
  await app.rail.go('runtime');
  await expect(app.runtime.dotfiles).toBeVisible();
  await expect(app.runtime.dotfile('.profile')).toHaveCount(0);
});

test('a dotfile with a name that is not one is not saved, and says why', async ({app}) => {
  await app.runtime.makeDotfile('no-dot', 'x\n');

  await expect(app.runtime.dotfiles.getByRole('alert')).toHaveText('A dotfile is named with a dot first: .profile');
  await expect(app.runtime.dotfile('no-dot')).toHaveCount(0);
});

test('Runtime is in parts as Remote is: the one chosen shows, the others blend into the ground until pressed', async ({app}) => {
  await app.runtime.open('This browser');
  const tabs = app.main.getByRole('tablist', {name: 'Runtime'});
  await expect(tabs.getByRole('tab')).toHaveText([/^This browser/, /^Environments/, /^Dotfiles/]);
  // No Prompt runs: its part is not offered.
  await expect(app.runtime.part('Prompts running')).toHaveCount(0);
  await expect(app.main.getByRole('tabpanel', {name: /^This browser/})).toBeVisible();
  await expect(app.runtime.dotfiles).toBeHidden();
  // Chosen, ink; the others have no fill or edge of their own until the pointer is on them.
  await expect(app.runtime.part('This browser')).toHaveCSS('background-color', 'rgb(41, 43, 42)');
  for (const p of ['Environments', 'Dotfiles'] as const) {
    await expect(app.runtime.part(p)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(app.runtime.part(p)).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  }
  await app.runtime.part('Dotfiles').hover();
  await expect(app.runtime.part('Dotfiles')).toHaveCSS('background-color', 'rgb(228, 228, 224)');
  // A dotfile half written stays while another part is shown.
  await app.runtime.part('Dotfiles').click();
  await app.runtime.dotfiles.getByRole('button', {name: /New dotfile/}).click();
  await app.runtime.dotfiles.getByRole('textbox').nth(1).fill('half written');
  await app.runtime.part('This browser').click();
  await app.runtime.part('Dotfiles').click();
  await expect(app.runtime.dotfiles.getByRole('textbox').nth(1)).toHaveValue('half written');
  // On a phone the switch is reached sideways.
  await app.page.setViewportSize({width: 390, height: 844});
  await app.runtime.part('Environments').click();
  await expect(app.runtime.part('Environments')).toBeInViewport();
});

test('the environments are one card two wide, the desktop app at its right and SSH under both: Length³ and its version apart, one Download a size smaller', async ({signedIn: app}) => {
  // The Remote has the release's files, as a deploy puts them there. (Signed in, so SSH is there to be under them.)
  await app.page.route('**/v1/desktop/**', (r) => (r.request().method() === 'HEAD' ? r.fulfill({status: 200, body: ''}) : r.continue()));
  await app.runtime.open('Environments');
  const panel = app.main.getByRole('tabpanel', {name: /^Environments/});
  const others = panel.getByRole('list', {name: 'Other environments'});
  await expect(others.getByRole('listitem')).toHaveText([/^Ubuntu 24\.04\.5 LTS.*In the app only/, /^Debian 13.*In the app only/, /^Custom.*Not yet/]);
  const env = others.locator('xpath=..');
  const app_ = panel.getByRole('region', {name: 'Desktop app'});
  await expect(app_).toBeVisible();
  const [e, d] = [(await env.boundingBox())!, (await app_.locator('.card').boundingBox())!];
  // Side by side, the environments at the left, ending level.
  expect(d.x).toBeGreaterThan(e.x + e.width);
  expect(Math.abs(d.y - e.y)).toBeLessThan(2);
  // As wide as two of Prompts running's cards side by side; SSH under the two, not beside them.
  expect(e.width).toBeGreaterThanOrEqual(2 * 270);
  const ssh = (await panel.getByRole('heading', {name: 'SSH'}).boundingBox())!;
  expect(ssh.y).toBeGreaterThan(Math.max(e.y + e.height, d.y + d.height));
  expect(Math.abs(ssh.x - e.x)).toBeLessThan(2);
  // One download: the .deb, which says what it is; no AppImage beside it.
  await expect(app_.getByRole('link')).toHaveCount(1);
  await expect(app_.getByRole('link', {name: 'Download'})).toHaveAttribute('href', /\.deb$/);
  await expect(app_).not.toContainText('AppImage');
  await expect(app_).toContainText('x86-64 Linux · .deb');
  // A size smaller than a small button, still 32 high to press.
  await expect(app_.getByRole('link', {name: 'Download'})).toHaveCSS('font-size', '13px');
  expect((await app_.getByRole('link', {name: 'Download'}).boundingBox())!.height).toBeGreaterThanOrEqual(32);
  // Length³, no OS; the version in another face.
  const title = app_.getByText(/^Length³ \d/);
  await expect(title).not.toContainText('OS');
  const version = title.locator('.version');
  await expect(version).toHaveText(/^\d+\.\d+\.\d+$/);
  const face = (l: Locator) => l.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(await face(version)).not.toBe(await face(title));
});

test("a repo's name in Runtime is the repo itself; its gear offers Forge or Free, and Free says what it does first", async ({signedIn: app}) => {
  await app.newRepo.make('notes');
  // Made, it was gone into, and its Prompt keeps it here: stopped, it can be freed.
  await app.runtime.stopPrompts();
  await app.runtime.open('This browser');
  const panel = app.main.getByRole('tabpanel', {name: /^This browser/});
  const here = panel.getByRole('region', {name: /^In this browser/});
  await expect(here).toContainText('In step');
  const gear = here.getByRole('button', {name: 'What to do with notes'});
  // Near the repo, its gear shows; showing it does nothing.
  await expect(gear).toHaveCSS('opacity', '0');
  await here.getByRole('button', {name: 'notes', exact: true}).hover();
  await expect(gear).toHaveCSS('opacity', '1');
  await gear.click();
  const menu = here.getByRole('menu', {name: 'What to do with notes'});
  await expect(menu.getByRole('menuitem')).toHaveText(['Open in Forge', 'Free from this device']);
  // Escape puts it away, and nothing changed.
  await app.page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(gear).toBeFocused();
  await gear.click();
  await expect(menu.getByRole('menuitem', {name: 'Free from this device'})).toBeEnabled();
  await menu.getByRole('menuitem', {name: 'Free from this device'}).click();
  const ask = menu.getByRole('group', {name: 'Free notes from this device'});
  await expect(ask).toContainText('notes leaves this device.It stays on the Remote and comes back when opened.');
  await app.answer(ask.getByRole('button', {name: 'Free', exact: true}), ask);
  // What it came to, over the box; and it is on the Remote now, to fetch.
  await expect(panel.getByRole('status').filter({hasText: 'Let go of'})).toBeVisible();
  const remote = panel.getByRole('region', {name: /^Only on the Remote/});
  await expect(remote.getByRole('button', {name: 'notes', exact: true})).toBeVisible();
  await remote.getByRole('button', {name: 'What to do with notes'}).click();
  const there = remote.getByRole('menu', {name: 'What to do with notes'});
  await expect(there.getByRole('menuitem', {name: 'Free from this device'})).toBeDisabled();
  await expect(there).toContainText('It is only on the Remote: nothing of it is here to free');
  await app.page.keyboard.press('Escape');
  // The name is the repo itself: its card on the Remote, lit.
  await remote.getByRole('button', {name: 'notes', exact: true}).click();
  await expect(app.remote.part('Repos')).toHaveAttribute('aria-selected', 'true');
  await expect(app.remote.card('notes')).toBeFocused();
});

test("Home's repo card: its body is the repo itself, its gear Forge or Free, as in Runtime", async ({signedIn: app}) => {
  await app.newRepo.make('notes');
  await app.runtime.stopPrompts();
  await app.rail.go('home');
  const card = app.main.getByRole('region', {name: 'Repos'}).getByRole('group', {name: 'notes', exact: true});
  await expect(card).toContainText('In step');
  const gear = card.getByRole('button', {name: 'What to do with notes'});
  const menu = card.getByRole('menu', {name: 'What to do with notes'});
  await gear.click();
  await expect(menu.getByRole('menuitem')).toHaveText(['Open in Forge', 'Free from this device']);
  await expect(menu.getByRole('menuitem', {name: 'Free from this device'})).toBeEnabled();
  await menu.getByRole('menuitem', {name: 'Free from this device'}).click();
  const ask = menu.getByRole('group', {name: 'Free notes from this device'});
  // Not now changes nothing.
  await ask.getByRole('button', {name: 'Not now'}).click();
  await expect(ask).toBeHidden();
  await expect(card).toContainText('In step');
  await menu.getByRole('menuitem', {name: 'Free from this device'}).click();
  await app.answer(ask.getByRole('button', {name: 'Free', exact: true}), ask);
  // Freed, its card is the Remote's: Only on the Remote. Its gear's Forge brings it back and opens it.
  await expect(card).toContainText('Only on the Remote');
  // Its body is the repo itself: its card on the Remote, with the keyboard on it.
  await card.getByRole('button', {name: /^notes/}).first().click();
  await expect(app.remote.card('notes')).toBeFocused();
  await app.rail.go('home');
  await gear.click();
  await menu.getByRole('menuitem', {name: 'Open in Forge'}).click();
  await expect(app.rail.button('forge')).toHaveAttribute('aria-current', 'page');
});
