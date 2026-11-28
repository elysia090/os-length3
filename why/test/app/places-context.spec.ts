import {join} from 'node:path';
import {devices} from '@playwright/test';
import {expect, test} from './fixtures.ts';

const normal = ['Home', 'Forge', 'Git', 'Server', 'Inbox', 'Runtime'];

test('one shared chooser keeps six destinations and restores keyboard and mouse access to legacy tools', async ({app}) => {
  const {page, forge} = app;
  await page.setViewportSize({width: 1536, height: 864});
  await app.newRepo.make('tool-sample');
  const key = forge.placesKey;
  const menu = forge.places;
  await key.click();
  await expect(menu.getByRole('menuitemradio')).toHaveText(normal);
  await expect(menu.getByRole('menuitem')).toHaveCount(0);
  await page.keyboard.press('Escape');

  const tools = page.getByRole('menu', {name: 'Tools', exact: true});
  await key.click({button: 'right'});
  await expect(tools.getByRole('menuitem')).toHaveText(['Files', 'Prompt', 'Plugin', 'New repo', 'Account']);
  await expect(tools.getByRole('menuitemradio')).toHaveCount(0);
  await tools.getByRole('menuitem', {name: 'Account'}).click();
  await expect(page.getByRole('menu', {name: 'Me', exact: true})).toBeVisible();
  await page.keyboard.press('Escape');

  await key.press('Shift+F10');
  await expect(tools.getByRole('menuitem', {name: 'Files', exact: true})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#file-tree.on-forge-desk')).toBeVisible();
  await page.keyboard.press('Escape');
  await key.click();
  await expect(menu.getByRole('menuitemradio')).toHaveText(normal);
  await menu.getByRole('menuitemradio', {name: 'Home', exact: true}).click();
  await app.rail.go('file');
  await expect(app.file.tree).toBeVisible();
  await page.keyboard.press('Escape');
  await app.rail.go('plugin');
  await expect(app.main.locator('.plugins:not([hidden])')).toBeVisible();
  await app.rail.go('remote');
  await expect(page.locator('#page')).toHaveAttribute('data-place', 'remote');
});

test.describe('390px Android Chromium emulation', () => {
  test.use({userAgent: devices['Pixel 7'].userAgent, deviceScaleFactor: devices['Pixel 7'].deviceScaleFactor,
    hasTouch: true, isMobile: true, viewport: {width: 390, height: 844}});

  test('the real paper-local Prompt key works by tap without opening either chooser', async ({app}) => {
    const {page, forge} = app;
    await app.newRepo.make('tool-sample');
    await expect(forge.editor('README.md')).toBeVisible();
    const prompt = app.main.locator('.forge-prompt-approach');
    const capture = (name: string) => process.env.PLACES_CAPTURE
      ? page.screenshot({path: join(process.env.PLACES_CAPTURE, name + '.png'), scale: 'css'}) : Promise.resolve();
    await expect(prompt).toHaveAccessibleName(/Prompt/);
    await expect(prompt).toBeInViewport({ratio: 1});
    expect((await prompt.boundingBox())!.height).toBe(44);
    await capture('390-prompt-approach');
    await prompt.tap();
    await expect(app.main.locator('.forge-prompt-slot')).toBeVisible();
    await expect(prompt).toHaveAccessibleName(/Back/);
    await expect(forge.places).toBeHidden();
    await capture('390-prompt-open');
    await prompt.tap();
    await expect(app.main.locator('.forge-prompt-slot')).toBeHidden();
    await expect(forge.editor('README.md')).toBeVisible();
  });

  test('a stationary touch on the title reaches the narrow Files tree', async ({app}) => {
    const {page, forge} = app;
    await app.newRepo.make('files-sample');
    const key = (await forge.placesKey.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const x = Math.round(key.x + key.width / 2), y = Math.round(key.y + key.height / 2);
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
    await page.waitForTimeout(700);
    await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    const files = page.getByRole('menu', {name: 'Tools', exact: true}).getByRole('menuitem', {name: 'Files', exact: true});
    await expect(files).toBeVisible({timeout: 3000});
    await files.tap();
    await expect(page.locator('#file-tree.on-forge-desk')).toBeVisible();
  });
});
