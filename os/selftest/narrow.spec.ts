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
    // Runtime's environments are read after it opens; measured before they are, its rows would never be.
    if (place === 'runtime') await expect(app.page.locator('.env-choice').first()).toBeVisible();
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

test('a window too short for the rail keeps + clear of the person\'s icon, and + is pressed', async ({app}) => {
  await app.page.setViewportSize({width: 720, height: 450});
  const plus = (await app.rail.button('new-repo').boundingBox())!;
  const me = (await app.me.button.boundingBox())!;
  expect(plus.y + plus.height).toBeLessThanOrEqual(me.y);
  await app.rail.go('new-repo');
});

test('on a phone, a device row shows the device\'s name beside when it was used', async ({signedIn: app}) => {
  await app.page.setViewportSize({width: 390, height: 844});
  await app.remote.part('Devices').click();
  const name = app.main.getByRole('tabpanel', {name: /^Devices/}).locator('.row-name').first();
  await expect(name).toBeVisible();
  expect((await name.boundingBox())!.width).toBeGreaterThan(100);
});

test('signed out, Server has no right pane and so no line where it would start', async ({app}) => {
  await app.server.openLayer();
  await expect(app.server.side).toBeHidden();
  await expect(app.server.layer.locator('.center')).toHaveCSS('border-right-color', 'rgba(0, 0, 0, 0)');
});

test('a build without l3 says so in Runtime, never a parser\'s words', async ({app}) => {
  await app.rail.go('runtime');
  await expect(app.main.getByRole('heading', {name: /Environment in effect/})).toBeVisible();
  await expect(app.main).not.toContainText(/Unexpected token|not valid JSON/);
});
