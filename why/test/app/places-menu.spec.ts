import {expect, test} from './fixtures.ts';

const work = ['Forge', 'Files', 'Git', 'Prompt', 'Home', 'Server', 'Runtime', 'Plugin', 'New repo', 'Account'];

test('Places shows five whole rows, scrolls in the menu, and keeps its actual destinations', async ({signedIn: app}) => {
  const {page, forge} = app;
  await page.setViewportSize({width: 1536, height: 864});
  await app.newRepo.make('corner');
  const paper = forge.piece('README.md'), menu = forge.places, key = forge.placesKey;
  const first = await paper.boundingBox(), keyAt = await key.boundingBox();
  const label = key.locator('.places-label');
  await expect(key).toHaveAccessibleName('Forge');
  const at = await label.boundingBox();
  const entries = menu.locator('button[role^="menuitem"]');
  await key.click();
  await expect(entries).toHaveText(work);
  await expect(menu.getByRole('menuitemradio', {name: 'Forge', exact: true})).toBeFocused();
  for (const name of work.slice(1, 4)) {
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', {name, exact: true}).or(
      menu.getByRole('menuitemradio', {name, exact: true}))).toBeFocused();
  }
  await expect(menu.getByRole('separator')).toHaveCount(0);
  await expect(key).toHaveAttribute('aria-expanded', 'true');
  await expect(key.locator('svg')).toHaveCount(0);
  expect(await label.boundingBox()).toEqual(at);
  const quiet = () => key.evaluate(el => {
    const light = getComputedStyle(el.parentElement!, '::before');
    return {content: light.content, ground: light.backgroundColor, dots: light.backgroundImage, opacity: Number(light.opacity),
      viewport: [light.top, light.right, light.bottom, light.left], animation: light.animationName, pointer: light.pointerEvents};
  });
  expect(await menu.evaluate(el => {
    const style = getComputedStyle(el);
    return [style.borderTopWidth, style.borderTopLeftRadius, style.boxShadow, style.backgroundColor, style.backgroundImage];
  })).toEqual(['0px', '0px', 'none', 'rgba(0, 0, 0, 0)', 'none']);
  const desk = await page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return {ground: style.backgroundColor, dots: style.backgroundImage};
  });
  const lower = await quiet();
  expect(lower).toMatchObject({...desk, viewport: ['0px', '0px', '0px', '0px'], animation: 'none', pointer: 'none'});
  expect(lower.content).not.toBe('none');
  expect(lower.opacity).toBeGreaterThan(0);
  expect(lower.opacity).toBeLessThan(1);
  expect(await key.boundingBox()).toEqual(keyAt);
  expect(await paper.boundingBox()).toEqual(first);

  const visible = () => menu.evaluate(el => {
    const frame = el.getBoundingClientRect(), top = frame.top + el.clientTop, bottom = top + el.clientHeight;
    const names: string[] = [], cut: string[] = [];
    for (const item of el.querySelectorAll('button')) {
      const box = item.getBoundingClientRect(), name = item.textContent!.trim();
      const range = document.createRange(); range.selectNodeContents(item);
      const text = range.getBoundingClientRect();
      if (box.top >= top && box.bottom <= bottom) names.push(name);
      if (text.bottom > top && text.top < bottom && (text.top < top || text.bottom > bottom)) cut.push(name);
    }
    return {names, cut, height: frame.height};
  });
  expect(await visible()).toEqual({names: work.slice(0, 5), cut: [], height: 140});
  await page.mouse.click(1400, 700);
  await expect(menu).toBeHidden();
  expect((await quiet()).content).toBe('none');
  expect(await paper.boundingBox()).toEqual(first);
  await key.click();
  await expect(menu).toBeVisible();
  await page.setViewportSize({width: 1536, height: 320});
  await expect.poll(visible).toEqual({names: work.slice(0, 4), cut: [], height: 112});
  const scroll = () => menu.evaluate(el => el.scrollTop);
  const world = await page.evaluate(() => scrollY);
  await menu.hover();
  await page.mouse.wheel(0, 152);
  await expect.poll(scroll).toBeGreaterThan(0);
  await page.keyboard.press('Home');
  await expect.poll(visible).toEqual({names: work.slice(0, 4), cut: [], height: 112});
  await page.keyboard.press('End');
  const account = menu.getByRole('menuitem', {name: 'Account', exact: true});
  await expect(account).toBeFocused();
  await expect.poll(visible).toEqual({names: work.slice(-4), cut: [], height: 112});
  expect(await page.evaluate(() => scrollY)).toBe(world);
  await account.press('Enter');
  const identity = page.getByRole('menu', {name: 'Me', exact: true});
  await expect(identity.getByRole('menuitem', {name: 'Devices', exact: true})).toBeVisible();
  await identity.getByRole('menuitem', {name: 'Devices', exact: true}).press('Escape');
  await expect(identity).toBeHidden();
  await expect(key).toBeFocused();

  await page.setViewportSize({width: 1536, height: 864});
  await app.rail.go('git');
  await page.setViewportSize({width: 1536, height: 160});
  await key.click();
  await expect(entries).toHaveText(work);
  const current = menu.getByRole('menuitemradio', {name: 'Git', exact: true});
  await expect(current).toBeFocused();
  await expect(current).toBeInViewport({ratio: 1});
  expect(await scroll()).toBe(0);
  await current.press('Escape');
  // Git is now the third row. At two rows, the focused destination must still scroll fully into view.
  await page.setViewportSize({width: 1536, height: 140});
  await key.click();
  await expect(current).toBeFocused();
  await expect(current).toBeInViewport({ratio: 1});
  await expect.poll(scroll).toBeGreaterThan(0);
  await current.press('Escape');
  await page.setViewportSize({width: 1536, height: 864});
  await app.inbox.named();
  await key.click();
  await expect(entries).toHaveText(['Server', 'Inbox', 'Your usernames', 'Home', 'Forge', 'Runtime', 'Plugin', 'New repo', 'Account']);
  await app.rail.go('home');
  await expect(app.rail.button('file')).toBeHidden();
  await key.press('Enter');
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  const file = menu.getByRole('menuitem', {name: 'File', exact: true});
  await expect(file).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(app.file.tree).toBeVisible();
  await expect(app.file.name('corner')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(app.file.tree).toBeHidden();
  await expect(key).toBeFocused();
});

test.describe('touch', () => {
  test.use({hasTouch: true, isMobile: true});

  test('the same place name and whole rows can be tapped at 390 and 320 pixels', async ({app}) => {
    await app.newRepo.make('field-notes');
    const key = app.forge.placesKey, menu = app.forge.places;
    for (const [width, height] of [[390, 844], [320, 568]]) {
      await app.page.setViewportSize({width, height});
      await expect(key).toHaveAccessibleName('Forge');
      const target = (await key.boundingBox())!;
      const label = (await key.locator('.places-label').boundingBox())!;
      expect([label.x, label.y, target.height]).toEqual([24, 24, 44]);
      expect(target.width).toBeGreaterThanOrEqual(44);
      await key.tap();
      await expect(menu).toBeVisible();
      const before = (await menu.boundingBox())!;
      expect(before.height).toBe(5 * 44);
      expect(before.x + before.width).toBeLessThan(width);
      await menu.getByRole('menuitemradio', {name: 'Files', exact: true}).tap();
      await expect(key).toHaveAccessibleName('Files');
      await expect(menu).toBeHidden();
      await key.tap();
      await menu.getByRole('menuitemradio', {name: 'Forge', exact: true}).tap();
      await expect(key).toHaveAccessibleName('Forge');
      await expect(menu).toBeHidden();
      // The quick sequence is not taken as a double-tap zoom on the adjacent name and option.
      expect(await app.page.evaluate(() => visualViewport!.scale)).toBe(1);
    }
  });
});
