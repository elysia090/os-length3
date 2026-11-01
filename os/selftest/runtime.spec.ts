import type {Locator} from '@playwright/test';
import {expect, test} from './fixtures.ts';

// Runtime: dotfiles are rows of one box (name, size); a dotfile saved is one,
// opens with its text under it, and is still there when the app is opened again.
// Remove asks in the box first, since it goes from every device.

test('a dotfile saved shows as a row, opens with its text under it, folds, and stays', async ({app}) => {
  await app.runtime.makeDotfile('.profile', 'export EDITOR=vi\n');

  await expect(app.runtime.dotfile('.profile')).toContainText('17 B');

  await app.open();
  await app.runtime.open('Dotfiles');
  await app.runtime.dotfile('.profile').click();
  await expect(app.runtime.text('.profile')).toHaveValue('export EDITOR=vi\n');
  await expect(app.runtime.dotfile('.profile')).toHaveAttribute('aria-expanded', 'true');
  // Under its row, in the box; pressed again, it folds, the keyboard still on it.
  expect(await app.runtime.dotfile('.profile').evaluate((row) => row.nextElementSibling?.classList.contains('dot-editor'))).toBe(true);
  await app.runtime.dotfile('.profile').click();
  await expect(app.runtime.text('.profile')).toHaveCount(0);
  await expect(app.runtime.dotfile('.profile')).toBeFocused();
});

test('removing a dotfile asks in its box: Not now keeps it, Remove takes it', async ({app}) => {
  await app.runtime.makeDotfile('.profile', 'export EDITOR=vi\n');
  // Saved, it stays open under its row.
  await expect(app.runtime.dotfile('.profile')).toHaveAttribute('aria-expanded', 'true');

  const ask = await app.runtime.askRemove('.profile');
  await expect(ask).toContainText('".profile" will be removed across all devices.');
  await ask.getByRole('button', {name: 'Cancel'}).click();
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

test('a new dotfile named as one there is is not saved over it, and says why', async ({app}) => {
  await app.runtime.makeDotfile('.profile', 'export EDITOR=vi\n');
  await app.runtime.makeDotfile('.profile', 'something else\n');
  await expect(app.runtime.dotfiles.getByRole('alert')).toHaveText('A dotfile named ".profile" already exists');
  await expect(app.runtime.dotfile('.profile')).toContainText('17 B');
});

test('a dotfile with a name that is not one is not saved, and says why', async ({app}) => {
  await app.runtime.makeDotfile('no-dot', 'x\n');

  await expect(app.runtime.dotfiles.getByRole('alert')).toHaveText('Dotfiles must begin with a dot (e.g. .profile)');
  await expect(app.runtime.dotfile('no-dot')).toHaveCount(0);
});

test('Runtime is in parts as Remote is: the one chosen shows, the others blend into the ground until pressed', async ({app}) => {
  await app.runtime.open('This browser');
  const tabs = app.main.getByRole('tablist', {name: 'Runtime'});
  await expect(tabs.getByRole('tab')).toHaveText([/^This browser/, /^Environments/, /^Dotfiles/, /^Agent/]);
  // No Prompt runs: its part is not offered.
  await expect(app.runtime.part('Running Prompts')).toHaveCount(0);
  await expect(app.main.getByRole('tabpanel', {name: /^This browser/})).toBeVisible();
  await expect(app.runtime.dotfiles).toBeHidden();
  // Chosen, ink; the others have no fill or edge of their own until the pointer is on them.
  await expect(app.runtime.part('This browser')).toHaveCSS('background-color', 'rgb(44, 42, 39)');
  for (const p of ['Environments', 'Dotfiles'] as const) {
    await expect(app.runtime.part(p)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(app.runtime.part(p)).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  }
  await app.runtime.part('Dotfiles').hover();
  await expect(app.runtime.part('Dotfiles')).toHaveCSS('background-color', 'rgb(230, 227, 222)');
  // A dotfile half written stays while another part is shown.
  await app.runtime.part('Dotfiles').click();
  await app.runtime.dotfiles.getByRole('button', {name: /New dotfile/}).click();
  await app.runtime.dotfiles.getByRole('textbox').nth(1).fill('half written');
  await app.runtime.part('This browser').click();
  await app.runtime.part('Dotfiles').click();
  await expect(app.runtime.dotfiles.getByRole('textbox').nth(1)).toHaveValue('half written');
  // On a phone the switch is reached sideways: a › at its end says there is more, and pressed, slides on to it.
  await app.page.setViewportSize({width: 390, height: 844});
  await app.runtime.part('This browser').click();
  const on = tabs.locator('.parts-on');
  await expect(on).toBeVisible();
  await expect(app.runtime.part('Agent')).not.toBeInViewport({ratio: 1});
  // A click brings what it presses into view first: under load that can slide the row to its end, the › going as
  // it gets there, and a click left waiting for it never comes. Not come within a second, it is asked again.
  await expect(async () => {
    if (await on.isVisible()) await on.click({timeout: 1000});
    await expect(app.runtime.part('Agent')).toBeInViewport({ratio: 1, timeout: 500});
  }).toPass();
  await expect(on).toBeHidden();
  await app.runtime.part('Environments').click();
  await expect(app.runtime.part('Environments')).toBeInViewport();
});

test("what is in this browser adds up to the total over it: what the browser counts besides is a row of its own", async ({app}) => {
  // Nothing written yet: Home's settings are nothing, and the browser counts its keeping of the OS all the same.
  await app.runtime.open('This browser');
  const here = app.main.getByRole('region', {name: /^In this browser/});
  await expect(here.getByText('Other', {exact: true})).toBeVisible();
  const read = (s: string) => {
    const [n, unit] = s.trim().split(' ');
    const by = ({B: 1, KB: 1e3, MB: 1e6, GB: 1e9} as Record<string, number>)[unit];
    // What it is to within the figure's last place.
    return {n: Number(n) * by, within: (n.includes('.') ? .05 : .5) * by};
  };
  const total = read(await here.getByRole('heading').locator('b').innerText());
  const rows = (await here.locator('.space-size').allInnerTexts()).map(read);
  const sum = rows.reduce((a, r) => a + r.n, 0);
  expect(Math.abs(sum - total.n)).toBeLessThanOrEqual(rows.reduce((a, r) => a + r.within, total.within));
  // The total said over the box is the one beside the bar.
  await expect(app.main.locator('.legend > span').first().locator('b')).toHaveText(await here.getByRole('heading').locator('b').innerText());
});

test('the environments are one card two wide, the desktop app at its right and SSH under both: Length³ and its version apart, one Download a size smaller', async ({signedIn: app}) => {
  // The Remote has the release's files, as a deploy puts them there. (Signed in, so SSH is there to be under them.)
  await app.page.route('**/v1/desktop/**', (r) => (r.request().method() === 'HEAD' ? r.fulfill({status: 200, body: ''}) : r.continue()));
  await app.runtime.open('Environments');
  const panel = app.main.getByRole('tabpanel', {name: /^Environments/});
  const others = panel.getByRole('list', {name: 'Other environments'});
  await expect(others.getByRole('listitem')).toHaveText([/^Ubuntu 26\.04\.1 LTS.*App only/, /^Debian 13\.7.*App only/, /^Custom.*Not yet/]);
  const env = others.locator('xpath=..');
  const app_ = panel.getByRole('region', {name: 'Desktop App'});
  await expect(app_).toBeVisible();
  const [e, d] = [(await env.boundingBox())!, (await app_.locator('.card').boundingBox())!];
  // Side by side, the environments at the left, ending level.
  expect(d.x).toBeGreaterThan(e.x + e.width);
  expect(Math.abs(d.y - e.y)).toBeLessThan(2);
  // As wide as two of Running Prompts's cards side by side; SSH under the two, not beside them.
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

test("a repo's name in Runtime opens it in Forge; its gear offers its card on the Remote, Rename, Free and Delete, and Free says what it does first", async ({signedIn: app}) => {
  await app.newRepo.make('notes');
  await app.runtime.open('This browser');
  const panel = app.main.getByRole('tabpanel', {name: /^This browser/});
  const here = panel.getByRole('region', {name: /^In this browser/});
  await expect(here).toContainText('Synced');
  // Shown in Forge, written to by nobody: no Prompt holds it.
  await expect(here).not.toContainText('Locked by an active Prompt');
  const gear = here.getByRole('button', {name: 'Actions for notes'});
  // Near the repo, its gear shows; showing it does nothing.
  await expect(gear).toHaveCSS('opacity', '0');
  await here.getByRole('button', {name: 'notes', exact: true}).hover();
  await expect(gear).toHaveCSS('opacity', '1');
  await gear.click();
  const menu = here.getByRole('menu', {name: 'Actions for notes'});
  // On Remote, it keeps the name the Remote knows it by: Rename is not offered, nor said why.
  await expect(menu.getByRole('menuitem')).toHaveText(['View on Remote', 'Remove from device (free space)', 'Delete']);
  await expect(menu.locator('.pop-note')).toHaveCount(0);
  // Escape puts it away, and nothing changed.
  await app.page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(gear).toBeFocused();
  await gear.click();
  await expect(menu.getByRole('menuitem', {name: 'Remove from device (free space)'})).toBeEnabled();
  await menu.getByRole('menuitem', {name: 'Remove from device (free space)'}).click();
  const ask = menu.getByRole('group', {name: 'Remove notes from device (free space)'});
  await expect(ask).toContainText('notes will be removed from this device.Preserved on Remote; re-downloads when opened.');
  await app.answer(ask.getByRole('button', {name: 'Free space', exact: true}), ask);
  // What it came to, over the box; and it is on the Remote now, to fetch.
  await expect(panel.getByRole('status').filter({hasText: 'Released'})).toBeVisible();
  const remote = panel.getByRole('region', {name: /^Remote only/});
  await expect(remote.getByRole('button', {name: 'notes', exact: true})).toBeVisible();
  await remote.getByRole('button', {name: 'Actions for notes'}).click();
  const there = remote.getByRole('menu', {name: 'Actions for notes'});
  // Remote only: nothing of it here to rename or free.
  await expect(there.getByRole('menuitem')).toHaveText(['View on Remote', 'Delete']);
  // Its card on the Remote, lit, with the keyboard on it.
  await there.getByRole('menuitem', {name: 'View on Remote'}).click();
  await expect(app.remote.part('Repos')).toHaveAttribute('aria-selected', 'true');
  await expect(app.remote.card('notes')).toBeFocused();
  // Its name is the repo itself: brought back here, and opened in Forge.
  await app.runtime.open('This browser');
  await panel.getByRole('region', {name: /^Remote only/}).getByRole('button', {name: 'notes', exact: true}).click();
  await expect(app.rail.button('forge')).toHaveAttribute('aria-current', 'page');
  await expect(app.forge.editor('README.md')).toBeVisible();
});

test("Home's repo card opens the repo in Forge, brought here first when it is only on the Remote; its gear is Runtime's", async ({signedIn: app}) => {
  await app.newRepo.make('notes');
  await app.rail.go('home');
  const card = app.main.getByRole('region', {name: 'Repos'}).getByRole('group', {name: 'notes', exact: true});
  await expect(card).toContainText('Synced');
  const gear = card.getByRole('button', {name: 'Actions for notes'});
  const menu = card.getByRole('menu', {name: 'Actions for notes'});
  await gear.click();
  await expect(menu.getByRole('menuitem')).toHaveText(['View on Remote', 'Remove from device (free space)', 'Delete']);
  await expect(menu.getByRole('menuitem', {name: 'Remove from device (free space)'})).toBeEnabled();
  await menu.getByRole('menuitem', {name: 'Remove from device (free space)'}).click();
  const ask = menu.getByRole('group', {name: 'Remove notes from device (free space)'});
  // Not now changes nothing.
  await ask.getByRole('button', {name: 'Cancel'}).click();
  await expect(ask).toBeHidden();
  await expect(card).toContainText('Synced');
  await menu.getByRole('menuitem', {name: 'Remove from device (free space)'}).click();
  await app.answer(ask.getByRole('button', {name: 'Free space', exact: true}), ask);
  // Freed, its card is the Remote's: Remote only. Pressed, it is brought back and opened in Forge.
  await expect(card).toContainText('Remote only');
  await card.getByRole('button', {name: /^notes/}).first().click();
  await expect(app.rail.button('forge')).toHaveAttribute('aria-current', 'page');
  await expect(app.forge.editor('README.md')).toBeVisible();
  // Its card on the Remote is the gear's to show.
  await app.rail.go('home');
  await gear.click();
  await menu.getByRole('menuitem', {name: 'View on Remote'}).click();
  await expect(app.remote.card('notes')).toBeFocused();
});

test('signed out, a repo is renamed and deleted from its gear, asked in place; Free, with no Remote to keep it, is not offered', async ({app}) => {
  await app.newRepo.make('oops');
  await app.rail.go('home');
  const repos = app.main.getByRole('region', {name: 'Repos'});
  const card = (name: string) => repos.getByRole('group', {name, exact: true});
  const gear = (name: string) => card(name).getByRole('button', {name: `Actions for ${name}`});
  const menu = (name: string) => card(name).getByRole('menu', {name: `Actions for ${name}`});
  await gear('oops').click();
  // No Remote to show it on, or to keep it if it were freed: neither is offered, and nothing is said of them.
  await expect(menu('oops').getByRole('menuitem')).toHaveText(['Rename', 'Delete']);
  await expect(menu('oops').locator('.pop-note')).toHaveCount(0);

  // Renamed in its row: a name it cannot be is said there, and Enter gives the one written.
  await menu('oops').getByRole('menuitem', {name: 'Rename'}).click();
  const field = menu('oops').getByRole('textbox', {name: 'New name'});
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('oops');
  await field.fill('trip notes');
  await field.press('Enter');
  await expect(menu('oops').getByRole('alert')).toHaveText('Use letters, digits, and . _ - (cannot start with .)');
  await expect(field).toBeFocused();
  await field.fill('trip');
  await field.press('Enter');
  await expect(card('trip')).toBeVisible();
  await expect(card('oops')).toHaveCount(0);
  await app.file.openTree();
  await expect(app.file.name('trip')).toBeVisible();
  await expect(app.file.name('oops')).toHaveCount(0);
  await app.file.close();

  // Deleted, asked in its row as File asks: what goes, and that nothing keeps it elsewhere.
  await gear('trip').click();
  await menu('trip').getByRole('menuitem', {name: 'Delete'}).click();
  const ask = menu('trip').getByRole('group', {name: 'Delete trip'});
  await expect(ask).toContainText('Permanently removes trip and its contents from this device.No backup exists; cannot be recovered.');
  await ask.getByRole('button', {name: 'Cancel'}).click();
  await expect(card('trip')).toBeVisible();
  await menu('trip').getByRole('menuitem', {name: 'Delete'}).click();
  await app.answer(ask.getByRole('button', {name: 'Delete', exact: true}), ask);
  await expect(card('trip')).toHaveCount(0);
  await app.rail.go('forge');
  await expect(app.main.getByRole('button', {name: /^Create your first repo/})).toBeVisible();
});

test('a repo renamed from its gear keeps its place on the band, worked on, with what was half written for it, its search, where one left off and its chip in Git', async ({app}) => {
  await app.newRepo.make('alpha');
  await app.newRepo.make('beta');
  await app.forge.open('alpha');
  // Read in it (Lately's where one left off), half written for it in the box (an issue, not a line for the Prompt),
  // and searched in it.
  await app.forge.editor('README.md').click();
  // (Taken as where one is a moment after the hand is still, as the page has it.)
  await app.page.waitForTimeout(400);
  await app.rail.go('home');
  await expect(app.page.getByRole('complementary').first()).toContainText('alpha · Continue where you left off');
  await app.rail.go('forge');
  await app.forge.promptBox.click();
  await app.forge.promptBox.press('Alt+2');
  await app.forge.promptBox.fill('Fix: the map is upside down');
  await app.forge.search.fill('needle');
  await app.rail.go('home');
  const repos = app.main.getByRole('region', {name: 'Repos'});
  await repos.getByRole('button', {name: 'Actions for alpha'}).click();
  const menu = repos.getByRole('menu', {name: 'Actions for alpha'});
  await menu.getByRole('menuitem', {name: 'Rename'}).click();
  await menu.getByRole('textbox', {name: 'New name'}).fill('gamma');
  await menu.getByRole('textbox', {name: 'New name'}).press('Enter');
  await expect(repos.getByRole('group', {name: 'gamma', exact: true})).toBeVisible();
  // Where one left off says it under its new name.
  await expect(app.page.getByRole('complementary').first()).toContainText('gamma · Continue where you left off');

  await app.rail.go('forge');
  const pills = app.forge.band.locator('.pill');
  await expect(pills).toHaveCount(2);
  await expect(pills.nth(0)).toHaveAttribute('data-repo', 'gamma');
  await expect(pills.nth(0)).toHaveAttribute('aria-current', 'page');
  await expect(pills.nth(1)).toHaveAttribute('data-repo', 'beta');
  await expect(app.forge.editor('README.md')).toHaveValue(/^# alpha/);
  await expect(app.forge.promptBox).toHaveValue('Fix: the map is upside down');
  await expect(app.forge.search).toHaveValue('needle');
  await app.rail.go('git');
  await expect(app.git.repos.getByRole('radio', {name: 'gamma', exact: true})).toBeVisible();
  await expect(app.git.repos.getByRole('radio', {name: 'alpha', exact: true})).toHaveCount(0);
});

test('signed in, a repo on the Remote is deleted from its gear as turning it off asks: it goes from here, and the Remote keeps it off', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('home');
  const card = app.main.getByRole('region', {name: 'Repos'}).getByRole('group', {name: 'hello', exact: true});
  await expect(card).toContainText('Synced');
  await card.getByRole('button', {name: 'Actions for hello'}).click();
  const menu = card.getByRole('menu', {name: 'Actions for hello'});
  await menu.getByRole('menuitem', {name: 'Delete'}).click();
  // Asked in the list as the switch on its card asks: its name written out, then a passkey (made there, the first time).
  const ask = menu.getByRole('group', {name: 'hello', exact: true});
  const name = ask.getByRole('textbox', {name: 'Repo name'});
  await expect(name).toBeFocused();
  await expect(ask).toContainText('Removes from device and Remote (held 30 days on Remote before final deletion).');
  await name.fill('hello');
  await app.answer(ask.getByRole('button', {name: 'Delete', exact: true}), ask);
  await expect(card).toHaveCount(0);
  // On Remote it is off, there to be turned on again for 30 days.
  await app.rail.go('remote');
  await expect(app.remote.power('hello')).toHaveAttribute('aria-checked', 'false');
  await expect(app.remote.card('hello')).toContainText('Disabled · Recoverable until');
});
