import type {Locator} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {shipped} from '../../shipto/release-pins.ts';
import {expect, test} from './fixtures.ts';
import {desktopPolicy} from '../../shipto/policy.ts';

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

test("Runtime's local switches keep a single underline and do not discard another part", async ({app}) => {
  await app.runtime.open('This browser');
  const tabs = app.main.getByRole('tablist', {name: 'Runtime'});
  await expect(tabs.getByRole('tab')).toHaveText([/^This browser/, /^Environments/, /^Dotfiles/, /^Agent/]);
  // No Prompt runs: its part is not offered.
  await expect(app.runtime.part('Running Prompts')).toHaveCount(0);
  await expect(app.main.getByRole('tabpanel', {name: /^This browser/})).toBeVisible();
  await expect(app.runtime.dotfiles).toBeHidden();
  // Only the word for the current panel gains the rule. None is filled or given its own frame.
  for (const p of ['This browser', 'Environments', 'Dotfiles'] as const) {
    const tab = app.runtime.part(p);
    await expect(tab).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(tab).toHaveCSS('border-top-width', '0px');
    expect(await tab.evaluate((el) => getComputedStyle(el, '::after').content)).toBe(p === 'This browser' ? '""' : 'none');
  }
  // Under the pointer its words go to ink, and nothing is laid under it (DESIGN §3: white is the hand's, with its shadow).
  await app.runtime.part('Dotfiles').hover();
  await expect(app.runtime.part('Dotfiles')).toHaveCSS('color', 'rgb(23, 22, 21)');
  await expect(app.runtime.part('Dotfiles')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
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
  await expect(here.getByText('Other (estimated)', {exact: true})).toBeVisible();
  const read = (s: string) => {
    const [n, unit] = s.trim().split(' ');
    const by = ({B: 1, KB: 1e3, MB: 1e6, GB: 1e9} as Record<string, number>)[unit];
    // What it is to within the figure's last place.
    return {n: Number(n) * by, within: (n.includes('.') ? .05 : .5) * by};
  };
  const total = read(await app.main.locator('.storage-amount strong').innerText());
  const rows = (await here.locator('.space-size').allInnerTexts()).map(read);
  const sum = rows.reduce((a, r) => a + r.n, 0);
  expect(Math.abs(sum - total.n)).toBeLessThanOrEqual(rows.reduce((a, r) => a + r.within, total.within));
  // The total is told once; the rendered strip uses the same bytes, not the browser quota.
  await expect(here.getByRole('heading').locator('b')).toHaveCount(0);
  const strip = app.main.locator('.storage-meter');
  const [width, segments] = await strip.evaluate((el) => [
    el.getBoundingClientRect().width,
    [...el.children].map((p) => [parseFloat(getComputedStyle(p).flexGrow), p.getBoundingClientRect().width]),
  ] as const);
  const bytesOnStrip = segments.reduce((n, [size]) => n + size, 0);
  expect(Math.abs(bytesOnStrip - total.n)).toBeLessThanOrEqual(total.within);
  for (const [size, drawn] of segments) expect(Math.abs(drawn - width * size / bytesOnStrip)).toBeLessThan(1);
});

test('Runtime lists each local repo once, keeps Remote below it, and restores the action after a transfer', async ({signedIn: app}) => {
  for (const name of ['sidecar', 'field-notes', 'small-hours']) await app.newRepo.make(name);
  await app.runtime.open('This browser');
  const {page, main} = app;
  const here = main.getByRole('region', {name: 'In this browser'});
  const remote = main.getByRole('region', {name: 'Remote only'});
  const repo = (scope: Locator, name: string) => scope.getByRole('button', {name, exact: true});
  const gear = (scope: Locator, name: string) => scope.getByRole('button', {name: `Actions for ${name}`, exact: true});
  await expect(main.locator('.storage-inventory > .storage-group')).toHaveCount(2);
  expect(await main.locator('.storage-inventory > .storage-group').evaluateAll(es => es.map(e => e.getAttribute('aria-labelledby'))))
    .toEqual(['here-col', 'remote-col']);
  for (const name of ['field-notes', 'small-hours', 'sidecar']) {
    await expect(repo(here, name)).toHaveCount(1);
    await expect(repo(remote, name)).toHaveCount(0);
  }
  // Cancelling a batch is read-only, even for an already backed-up repo.
  const batch = here.getByRole('button', {name: 'Free all', exact: true});
  await batch.click();
  const batchAsk = here.getByRole('group', {name: /^Free /});
  await expect(batchAsk).toContainText('3 items');
  await expect(batchAsk.getByRole('button', {name: 'Cancel'})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(batchAsk).toHaveCount(0);
  await expect(batch).toBeFocused();
  await expect(repo(here, 'field-notes')).toBeVisible();
  await gear(here, 'field-notes').press('Enter');
  await here.getByRole('menuitem', {name: 'Remove from device (free space)', exact: true}).click();
  const ask = here.getByRole('group', {name: 'Remove field-notes from device (free space)'});
  await app.answer(ask.getByRole('button', {name: 'Free space', exact: true}), ask);
  await expect(repo(remote, 'field-notes')).toBeVisible();
  await expect(repo(here, 'field-notes')).toHaveCount(0);
  await expect(gear(remote, 'field-notes')).toBeFocused();
  // The last real local control is followed by the first Remote row, in DOM and tab order.
  await here.locator('.space-list .repo-gear-button').last().focus();
  await page.keyboard.press('Tab');
  await expect(repo(remote, 'field-notes')).toBeFocused();
  await gear(remote, 'field-notes').press('Enter');
  await remote.getByRole('menuitem', {name: 'Fetch', exact: true}).click();
  await expect(repo(here, 'field-notes')).toBeVisible();
  await expect(repo(remote, 'field-notes')).toHaveCount(0);
  await expect(gear(here, 'field-notes')).toBeFocused();
  await expect(main).toHaveAttribute('data-place', 'runtime');

  const key = main.getByRole('button', {name: 'Places', exact: true});
  await key.press('Enter');
  await main.getByRole('menuitem', {name: 'File', exact: true}).click();
  await expect(app.file.tree).toBeVisible();
  await expect(app.file.tree.locator('.tree-name:visible').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(key).toBeFocused();
});

test('a confirmed Runtime batch only removes reclaimable local copies and leaves their Remote copies', async ({signedIn: app}) => {
  for (const name of ['left', 'right']) await app.newRepo.make(name);
  await app.runtime.open('This browser');
  const here = app.main.getByRole('region', {name: 'In this browser'});
  const remote = app.main.getByRole('region', {name: 'Remote only'});
  await here.getByRole('button', {name: 'Free all', exact: true}).click();
  const ask = here.getByRole('group', {name: /^Free /});
  await expect(ask).toContainText('2 items');
  await expect(ask).toContainText('Copies stay on Remote.');
  await app.answer(ask.getByRole('button', {name: 'Free space', exact: true}), ask);
  await expect(here.getByText('Settings and TODO')).toBeVisible();
  await expect(here.getByRole('button', {name: /^(left|right)$/})).toHaveCount(0);
  await expect(remote.getByRole('button', {name: /^(left|right)$/})).toHaveCount(2);
  await expect(app.main.getByRole('status').filter({hasText: 'Released'})).toContainText('2 items');
  await expect(here.getByRole('heading')).toBeFocused();
});

test('unknown browser quota does not replace the independently measured local bytes with zero', async ({app}) => {
  await app.newRepo.make('understood');
  await app.page.addInitScript(() => {
    Object.defineProperty(StorageManager.prototype, 'estimate', {value: async () => { throw new Error('Browser has no quota estimate'); }});
  });
  await app.open();
  await app.runtime.open('This browser');
  const hero = app.main.locator('.storage-hero');
  await expect(hero.getByText('Storage capacity unavailable')).toBeVisible();
  await expect(hero.locator('.storage-amount strong')).not.toHaveText('0 B');
  await expect(hero.getByText('Quota', {exact: true})).toHaveCount(0);
  const here = app.main.getByRole('region', {name: 'In this browser'});
  await expect(here.getByRole('button', {name: 'understood', exact: true})).toBeVisible();
  await expect(here.getByRole('button', {name: 'Free all', exact: true})).toHaveCount(0);
});

test('one reclaimable repo offers its Free command in its row menu; Escape takes back the ask', async ({signedIn: app}) => {
  await app.newRepo.make('field-notes');
  await app.runtime.open('This browser');
  const panel = app.main.getByRole('tabpanel', {name: /^This browser/});
  const here = panel.getByRole('region', {name: 'In this browser'});
  await expect(here.getByRole('button', {name:'Free space',exact:true})).toHaveCount(0);
  await expect(here.getByRole('button', {name:'Free all',exact:true})).toHaveCount(0);
  await expect(panel.locator('.storage-host')).toContainText('Estimated');
  const gear = here.getByRole('button', {name:'Actions for field-notes',exact:true});
  await gear.press('Enter');
  const menu = here.getByRole('menu', {name:'Actions for field-notes',exact:true});
  const move = menu.getByRole('menuitem', {name:'Remove from device (free space)',exact:true});
  await expect(menu.getByRole('menuitem',{name:'View on Remote',exact:true})).toBeFocused();
  await expect(move).toBeEnabled();
  // Before the first sync the same menu can also offer Rename, so follow the visible options.
  const options = await menu.getByRole('menuitem').count();
  for (let i = 0; i < options; i++) {
    await app.page.keyboard.press('ArrowDown');
    if (await move.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(move).toBeFocused();
  await app.page.keyboard.press('Enter');
  const ask = here.getByRole('group',{name:'Remove field-notes from device (free space)'});
  await expect(ask).toBeVisible();
  await app.page.keyboard.press('Escape');
  await expect(ask).toHaveCount(0);
  await expect(move).toBeFocused();
  await app.page.keyboard.press('Escape');
  await expect(gear).toBeFocused();
  await expect(panel.getByRole('region',{name:/^In this browser/}).getByRole('button',{name:'field-notes',exact:true})).toBeVisible();
});

test.describe('narrow Runtime', () => {
  test.use({viewport: {width: 390, height: 844}, hasTouch: true, isMobile: true});
  test('the row menu fits and answers a real touch, without hover', async ({signedIn: app}) => {
    await app.newRepo.make('touch-notes');
    await app.runtime.open('This browser');
    const free = app.main.getByRole('region', {name: 'In this browser'});
    const row = free.locator('[data-space-item="repo:touch-notes"]');
    await expect(row.locator('.space-mark[data-capacity="free"]')).toBeVisible();
    await expect(row.getByText('Ready to free', {exact: true})).toHaveClass('sr-only');
    const gear = free.getByRole('button', {name: 'Actions for touch-notes', exact: true});
    await gear.tap({timeout: 7000});
    const command = free.getByRole('menuitem', {name: 'Remove from device (free space)', exact: true});
    await expect(command).toBeEnabled();
    await expect(gear).toHaveAttribute('aria-expanded', 'true');
    await command.tap({timeout: 7000});
    const ask = free.getByRole('group', {name: 'Remove touch-notes from device (free space)'});
    await expect(ask).toBeVisible();
    await ask.getByRole('button', {name: 'Cancel', exact: true}).tap({timeout: 7000});
    await expect(ask).toHaveCount(0);
    await expect(command).toBeFocused();
  });
});

test('environments, desktop installer and SSH read in one line of measure: real version and one download', async ({signedIn: app}) => {
  // This checks metadata and layout, not a guest boot or the bundled pack.
  await app.page.route('**/webroot/webroot.json', (r) => r.fulfill({json: {
    version: shipped(), sha256: '0'.repeat(64), root: {name: 'Ricebox'},
  }}));
  // The Remote has the release's files, as a deploy puts them there. (Signed in, so SSH is there to be under them.)
  await app.page.route('**/v1/desktop/**', (r) => (r.request().method() === 'HEAD' ? r.fulfill({status: 200, body: ''}) : r.continue()));
  await app.runtime.open('Environments');
  const panel = app.main.getByRole('tabpanel', {name: /^Environments/});
  const others = panel.getByRole('list', {name: 'Other environments'});
  await expect(others.getByRole('listitem')).toHaveText([/^Ubuntu 26\.04\.1 LTS.*App only/, /^Debian 13\.7.*App only/, /^Custom.*Not yet/]);
  const env = others.locator('xpath=..');
  await expect(env.locator('.card-title')).toHaveText(/^Ricebox(?: \d+\.\d+\.\d+)?$/);
  const app_ = panel.getByRole('region', {name: 'Desktop App'});
  await expect(app_).toBeVisible();
  const [e, d] = [(await env.boundingBox())!, (await app_.locator('.app-card').boundingBox())!];
  const ssh = (await panel.getByRole('heading', {name: 'SSH'}).boundingBox())!;
  // One shared left edge and enough measure for the names: installers and SSH follow, not equal cards.
  expect([d.x, ssh.x]).toEqual([e.x, e.x]);
  expect(e.width).toBeGreaterThanOrEqual(24 * 24);
  expect(d.y).toBeGreaterThan(e.y + e.height);
  expect(ssh.y).toBeGreaterThan(d.y + d.height);
  // One download: the .deb, which says what it is; no AppImage beside it.
  await expect(app_.getByRole('link')).toHaveCount(1);
  const release = shipped();
  await expect(app_.getByRole('link', {name: 'Download'})).toHaveAttribute('href', `/v1/desktop/os-length3-linux-${release}-desktop-amd64.deb`);
  await expect(app_).toContainText(`Installer from distribution release ${release}`);
  await expect(app_).not.toContainText('AppImage');
  await expect(app_).toContainText('x86-64 Linux · .deb');
  // At the words' size (DESIGN §3: what says less is quieter, never smaller), 32 high to press.
  await expect(app_.getByRole('link', {name: 'Download'})).toHaveCSS('font-size', '17px');
  expect((await app_.getByRole('link', {name: 'Download'}).boundingBox())!.height).toBeGreaterThanOrEqual(32);
  // why*; the version in another face.
  const title = app_.getByText(/^why\* \d/);
  await expect(title).not.toContainText('OS');
  const version = title.locator('.version');
  const whyVersion = readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim();
  await expect(version).toHaveText(whyVersion);
  const build = await app.page.locator('meta[name="why-build"]').getAttribute('content');
  expect(build?.split(' ')[0]).toBe(whyVersion);
  const face = (l: Locator) => l.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(await face(version)).not.toBe(await face(title));
});

test('the Runtime Agent field stays masked and keeps a draft across the real horizontal tabs', async ({app}) => {
  await app.runtime.open('Agent');
  const agent = app.main.getByRole('tabpanel', {name: 'Agent', exact: true});
  const key = agent.getByLabel('API key');
  const size = await app.main.getByRole('tablist', {name: 'Runtime'}).boundingBox();
  await expect(key).toHaveAttribute('type', 'password');
  await expect(agent.getByRole('button', {name: 'Use'})).toBeDisabled();
  await key.fill('not-a-key-test');
  await expect(agent.getByRole('button', {name: 'Use'})).toBeEnabled();
  await app.runtime.part('This browser').click();
  await expect(key).toBeHidden();
  await app.runtime.part('Agent').click();
  await expect(key).toHaveValue('not-a-key-test');
  expect(await app.main.getByRole('tablist', {name: 'Runtime'}).boundingBox()).toEqual(size);
  await key.fill('');
});

test("a repo's name in Runtime opens it in Forge; its gear offers its card on the Remote, Rename, Free and Delete, and Free says what it does first", async ({signedIn: app}) => {
  await app.newRepo.make('notes');
  await app.runtime.open('This browser');
  const panel = app.main.getByRole('tabpanel', {name: /^This browser/});
  const here = panel.getByRole('region', {name: /^In this browser/});
  await expect(here.getByRole('button', {name: 'notes', exact: true})).toBeVisible();
  // This branch checks the controls of an already-backed-up repo; let the real Remote acknowledge the copy.
  await expect(here.locator('[data-space-item="repo:notes"] .space-mark[data-capacity="free"]')).toBeVisible();
  // Shown in Forge, written to by nobody: no Prompt holds it.
  await expect(here).not.toContainText('Locked by an active Prompt');
  const gear = here.getByRole('button', {name: 'Actions for notes'});
  // Its gear is there always, quiet (it waits on no pointer), and inked while the repo is used; showing it does nothing.
  await expect(gear).toHaveCSS('opacity', '1');
  const quiet = await gear.evaluate((el) => getComputedStyle(el).color);
  await here.getByRole('button', {name: 'notes', exact: true}).hover();
  await expect.poll(() => gear.evaluate((el) => getComputedStyle(el).color)).not.toBe(quiet);
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
  await expect(there.getByRole('menuitem')).toHaveText(['View on Remote', 'Fetch', 'Delete']);
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
  await expect(app.forge.desk).toHaveCount(0);
  await app.main.getByRole('button', {name: 'Open Folder', exact: true}).click();
  const folders = app.page.getByRole('dialog', {name: 'Open Folder', exact: true});
  await expect(folders.getByRole('status')).toHaveText('No repos yet');
  await folders.getByRole('button', {name: 'Create your first repo', exact: true}).click();
  await expect(folders).toBeHidden();
  await expect(app.page.locator('#page')).toHaveAttribute('data-place', 'new-repo');
});

test('a repo renamed from its gear keeps its desk, what was half written for it, its search, where one left off and its name in Git', async ({app}) => {
  await app.newRepo.make('alpha');
  await app.newRepo.make('beta');
  await app.forge.open('alpha');
  // Read in it (Lately's where one left off), half written for it in the box (an issue, not a line for the Prompt),
  // and searched in it.
  await app.forge.editor('README.md').click();
  // (Taken as where one is a moment after the hand is still, as the page has it.)
  await app.page.waitForTimeout(400);
  await app.rail.go('home');
  const latelyA = app.main.getByRole('region', {name: 'Recent activity'});
  await expect(latelyA).toContainText('Continue where you left off');
  await expect(latelyA).toContainText('alpha');
  await app.rail.go('forge');
  await app.forge.openPrompt();
  await app.forge.promptBox.press('Alt+2');
  await app.forge.promptBox.fill('Fix: the map is upside down');
  await app.forge.find('needle');
  await app.rail.go('home');
  const repos = app.main.getByRole('region', {name: 'Repos'});
  await repos.getByRole('button', {name: 'Actions for alpha'}).click();
  const menu = repos.getByRole('menu', {name: 'Actions for alpha'});
  await menu.getByRole('menuitem', {name: 'Rename'}).click();
  await menu.getByRole('textbox', {name: 'New name'}).fill('gamma');
  await menu.getByRole('textbox', {name: 'New name'}).press('Enter');
  await expect(repos.getByRole('group', {name: 'gamma', exact: true})).toBeVisible();
  // Where one left off says it under its new name.
  const latelyG = app.main.getByRole('region', {name: 'Recent activity'});
  await expect(latelyG).toContainText('Continue where you left off');
  await expect(latelyG).toContainText('gamma');

  await app.rail.go('forge');
  // Its desk is the one on screen, under its new name, as it was left.
  await expect(app.main.getByRole('region', {name: 'Files in gamma', exact: true})).toBeVisible();
  await expect(app.main.getByRole('region', {name: 'Files in alpha', exact: true})).toHaveCount(0);
  await expect(app.forge.editor('README.md')).toHaveValue(/^# alpha/);
  await app.forge.openPrompt();
  await app.forge.promptBox.press('Alt+2');
  await expect(app.forge.promptBox).toHaveAttribute('placeholder', 'Create issue in gamma');
  await expect(app.forge.promptBox).toHaveValue('Fix: the map is upside down');
  await app.page.keyboard.press('Control+k');
  await expect(app.forge.search).toHaveValue('needle');
  await app.rail.go('git');
  await app.page.getByRole('button', {name: 'Git folder: gamma', exact: true}).click();
  const gitFolders = app.page.getByRole('menu', {name: 'Git folders', exact: true});
  await expect(gitFolders.getByRole('menuitemradio', {name: 'gamma', exact: true})).toHaveAttribute('aria-checked', 'true');
  await expect(gitFolders.getByRole('menuitemradio', {name: 'alpha', exact: true})).toHaveCount(0);
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

// The look, changed by the one at it: the lines of a dotfile, .everyday (ricebox/everyday holds each to what the
// sheets let be changed and to the words that must stay read). Worn as it is saved and when the app is opened
// again; a line that would not be read, or is no change, is left out and the rest stands; with the file gone, the
// page is as its sheets have it.
for (const strict of [false, true]) test(`a look changed in .everyday is worn, what would not be read left out, and gone with the file${strict ? ' under desktop CSP' : ''}`, async ({app, page}) => {
  if (strict) {
    // Apply the actual desktop policy as a document response header, not a
    // permissive test page. The web meta policy cannot relax this header.
    await page.route(new URL('/', page.url()).href, async route => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const response = await route.fetch();
      await route.fulfill({response, headers: {...response.headers(), 'content-security-policy': desktopPolicy('')}});
    });
    await app.open();
    const inline = await page.evaluate(() => {
      const blocked = document.createElement('style');
      blocked.textContent = ':root { --everyday-csp-probe: blocked; }';
      document.head.append(blocked);
      const value = getComputedStyle(document.documentElement).getPropertyValue('--everyday-csp-probe');
      blocked.remove();
      return value;
    });
    expect(inline).toBe('');
  }
  const colour = (token: string) => page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), token);
  const ground = () => colour('--ground');
  const worn = () => page.evaluate(() => {
    const style = document.documentElement.style;
    return {ground: style.getPropertyValue('--ground'), pace: style.getPropertyValue('--pace')};
  });
  expect(await ground()).toBe('#dcd9d4');
  expect(await worn()).toEqual({ground: '', pace: ''});
  await page.evaluate(() => document.documentElement.style.setProperty('--everyday-unrelated', 'kept'));

  // The ground warmer and moves half as long; terminal text the same colour as its own background, and a line that says nothing.
  const ink = await colour('--ink');
  await app.runtime.makeDotfile('.everyday', `ground: #e9e4d8\npace: 0.5\ngreen: ${ink}\nnonsense; } body { display: none\n`);
  await expect.poll(worn).toEqual({ground: '#e9e4d8', pace: '0.5'});
  expect(await colour('--everyday-unrelated')).toBe('kept');
  expect(await ground()).toBe('#e9e4d8');
  const notes = app.runtime.dotfiles.getByRole('status').filter({hasText: 'Theme lines not applied'});
  await expect(notes).toContainText('Line 3: green would not be read on ink');
  await expect(notes).toContainText('Line 4: not a change');

  await app.open();
  await expect.poll(ground).toBe('#e9e4d8');

  await app.runtime.open('Dotfiles');
  await app.runtime.dotfile('.everyday').click();
  await expect(notes).toContainText('Line 3: green would not be read on ink');
  await app.runtime.text('.everyday').fill('ground: #e9e4d8\npace: 0.5\n');
  await app.runtime.dotfiles.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(notes).toHaveCount(0);
  expect(await ground()).toBe('#e9e4d8');

  await page.evaluate(() => document.documentElement.style.setProperty('--everyday-unrelated', 'kept'));
  const ask = await app.runtime.askRemove('.everyday');
  await app.answer(ask.getByRole('button', {name: 'Remove', exact: true}), ask);
  await expect.poll(worn).toEqual({ground: '', pace: ''});
  expect(await colour('--everyday-unrelated')).toBe('kept');
  expect(await ground()).toBe('#dcd9d4');
});
