import {expect, test} from './fixtures.ts';

const work = ['Prompt', 'Forge', 'Files', 'Git', 'Home', 'Server', 'Runtime', 'Plugin', 'New repo', 'Account'];

test('Places shows five whole rows, scrolls in the menu, and keeps its actual destinations', async ({signedIn: app}) => {
  const {page, forge} = app;
  await page.setViewportSize({width: 1536, height: 864});
  await app.newRepo.make('corner');
  const paper = forge.piece('README.md'), menu = forge.places, key = forge.placesKey;
  const first = await paper.boundingBox(), keyAt = await key.boundingBox();
  const glyph = await key.locator('svg path').getAttribute('d');
  const entries = menu.locator('button[role^="menuitem"]');
  await key.click();
  await expect(entries).toHaveText(work);
  await expect(menu.getByRole('separator')).toHaveCount(0);
  await expect(key.locator('svg path')).toHaveAttribute('d', glyph!);
  expect(await key.evaluate(el => getComputedStyle(el, '::before').width)).toBe('28px');
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
  expect(await visible()).toEqual({names: work.slice(0, 5), cut: [], height: 142});
  await page.setViewportSize({width: 1536, height: 320});
  await expect.poll(visible).toEqual({names: work.slice(0, 4), cut: [], height: 114});
  const scroll = () => menu.evaluate(el => el.scrollTop);
  const world = await page.evaluate(() => scrollY);
  await menu.hover();
  await page.mouse.wheel(0, 152);
  await expect.poll(scroll).toBeGreaterThan(0);
  await page.keyboard.press('Home');
  await expect.poll(visible).toEqual({names: work.slice(0, 4), cut: [], height: 114});
  await page.keyboard.press('End');
  const account = menu.getByRole('menuitem', {name: 'Account', exact: true});
  await expect(account).toBeFocused();
  await expect.poll(visible).toEqual({names: work.slice(-4), cut: [], height: 114});
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
  await expect.poll(scroll).toBeGreaterThan(0);
  await current.press('Escape');
  await page.setViewportSize({width: 1536, height: 864});
  await app.inbox.named();
  await key.click();
  await expect(entries).toHaveText(['Server', 'Inbox', 'Your usernames', 'Home', 'Forge', 'Runtime', 'Plugin', 'New repo', 'Account']);
  await app.rail.go('home');
  await expect(app.rail.button('file')).toBeVisible();
  await app.file.openTree();
  await expect(app.file.tree).toBeVisible();
});
