import type {Page} from '@playwright/test';
import {expect, test} from './fixtures.ts';

// Narrow and short windows: a phone's 320 px, a laptop at 200% zoom. Nothing
// scrolls the page sideways, nothing lies under something else, and a row's
// name is never squeezed to nothing by what is said beside it.

const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test('a 320 px window never scrolls sideways, with the menus out or put away', async ({app}) => {
  await app.page.setViewportSize({width: 320, height: 700});
  // In a wide face, as on a machine without the narrow system one: what fits only in a narrow font is caught here too.
  await app.page.addStyleTag({content: '* { font-family: "DejaVu Sans", "DejaVu Sans Mono", sans-serif !important; }'});
  for (const place of ['home', 'forge', 'git', 'runtime', 'remote', 'inbox', 'new-repo'] as const) {
    await app.rail.go(place);
    // Runtime is in parts, each measured; its environments are read after it opens, so they are waited for.
    if (place === 'runtime') {
      for (const part of ['This browser', 'Dotfiles', 'Environments'] as const) {
        await app.runtime.part(part).click();
        expect(await sideways(app.page), `runtime ${part}`).toBeLessThanOrEqual(0);
      }
      await expect(app.main.getByRole('list', {name: 'Other environments'})).toBeVisible();
    }
    expect(await sideways(app.page), place).toBeLessThanOrEqual(0);
  }
  await app.me.openMenu();
  expect(await sideways(app.page), 'the person\'s menu').toBeLessThanOrEqual(0);
  await app.page.keyboard.press('Escape');
  await app.file.openTree();
  expect(await sideways(app.page), 'File').toBeLessThanOrEqual(0);
  const tree = (await app.file.tree.boundingBox())!;
  expect(tree.x + tree.width).toBeLessThanOrEqual(320);
});

test('on a phone, Forge has one Places key; its menu, summoned Search, and the sheet in hand are whole in the window', async ({app}) => {
  const {forge, page} = app;
  await app.newRepo.make('trip-notes');
  await app.newRepo.openInForge();
  await page.setViewportSize({width: 390, height: 844});
  expect(await sideways(page), 'Forge').toBeLessThanOrEqual(0);
  await expect(forge.search).toBeHidden();
  await expect(forge.placesKey).toBeInViewport({ratio: 1});
  await forge.placesKey.click();
  await expect(forge.places).toBeInViewport({ratio: 1});
  const destinations = forge.places.getByRole('menuitemradio');
  await expect(destinations).toHaveText(['Forge', 'Files', 'Git']);
  await expect(forge.places.getByRole('menuitem', {name: 'Prompt', exact: true})).toBeInViewport({ratio: 1});
  for (const key of await destinations.all()) await expect(key).toBeInViewport({ratio: 1});
  await expect(forge.places.getByRole('menuitem', {name: 'Home', exact: true})).toBeInViewport({ratio: 1});
  expect(await sideways(page), 'Places').toBeLessThanOrEqual(0);
  await forge.placesKey.press('Escape');
  await page.keyboard.press('Control+k');
  await expect(forge.search).toBeFocused();
  await expect(forge.search).toBeInViewport({ratio: 1});
  expect(await sideways(page), 'Search').toBeLessThanOrEqual(0);
  // The file in hand is whole in sight with its shadow, the desk turned to it.
  await forge.editor('README.md').focus();
  await expect(forge.search).toBeHidden();
  const paper = forge.piece('README.md');
  const shade = 4;
  await expect(paper).toHaveCSS('box-shadow', / 4px 4px 0px 0px$/);
  const [d, b] = [(await forge.desk.boundingBox())!, (await paper.boundingBox())!];
  // As many whole cells as the desk has room for, with today's thinner shadow wholly in sight too.
  expect(b.width + shade).toBeLessThanOrEqual(d.width);
  expect(b.width % 24).toBe(0);
  await expect.poll(async () => {
    const r = (await paper.boundingBox())!;
    return r.x >= d.x && r.x + r.width + shade <= d.x + d.width
      && r.y >= d.y && r.y + r.height + shade <= d.y + d.height;
  }).toBe(true);
});

test('a profile with a word longer than a phone is wide breaks in the word, never pushing Home sideways', async ({signedIn: app}) => {
  await app.page.setViewportSize({width: 390, height: 844});
  const long = 'Supercalifragilisticexpialidocious'.repeat(4);
  await app.rail.go('home');
  const name = app.page.locator('#profile-name');
  await name.click();
  await name.fill(`Bartholomew ${long}`);
  await name.press('Enter');
  // (The line about them is there to be written while the profile has the keyboard.)
  const bio = app.main.getByRole('textbox', {name: 'Bio', exact: true});
  await name.click();
  await app.main.getByRole('button', {name: 'Short bio', exact: true}).click();
  await bio.fill(`${long} and more`);
  await bio.press('Enter');
  await expect(app.main.getByRole('heading', {name: /^Bartholomew/})).toBeVisible();
  expect(await sideways(app.page)).toBeLessThanOrEqual(0);
});

test('a window too short for the rail keeps + clear of the person\'s icon, and + is pressed', async ({app}) => {
  await app.page.setViewportSize({width: 720, height: 450});
  const plus = (await app.rail.button('new-repo').boundingBox())!;
  const me = (await app.me.button.boundingBox())!;
  expect(plus.y + plus.height).toBeLessThanOrEqual(me.y);
  await app.rail.go('new-repo');
});

test('on a phone, a device row shows the device\'s name beside when it was used', async ({signedIn: app}) => {
  await app.rail.go('remote');
  await app.page.setViewportSize({width: 390, height: 844});
  await app.remote.part('Devices').click();
  const name = app.main.getByRole('tabpanel', {name: /^Devices/}).locator('.row-name').first();
  await expect(name).toBeVisible();
  expect((await name.boundingBox())!.width).toBeGreaterThan(100);
});

test('signed out, Server has no right pane and so no line where it would start', async ({app}) => {
  await app.server.open();
  await expect(app.server.side).toBeHidden();
  await expect(app.server.view.locator('.center')).toHaveCSS('border-right-color', 'rgba(0, 0, 0, 0)');
});

test('a build without why says so in Runtime, never a parser\'s words', async ({app}) => {
  await app.runtime.open('Environments');
  await expect(app.main.getByRole('heading', {name: /Active environment/})).toBeVisible();
  await expect(app.main).not.toContainText(/Unexpected token|not valid JSON/);
});
