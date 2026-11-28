import {expect, test} from './fixtures.ts';

test.use({viewport: {width: 320, height: 568}, isMobile: true, hasTouch: true});

test('Home’s repo key opens and closes in place at the foot of a phone; only the name travels', async ({signedIn: app}) => {
  const {page} = app;
  const name = 'repo-actions';
  await app.newRepo.make(name);
  await app.rail.go('home');
  const row = app.main.getByRole('group', {name, exact: true});
  const chevron = row.getByRole('button', {name: `Actions for ${name}`});
  const menu = row.getByRole('menu', {name: `Actions for ${name}`});
  await expect(chevron).toBeVisible();
  // Put the key visibly at the foot, leaving no room below for its menu. Tap physical coordinates so the
  // test runner does not scroll the key into the middle of the view before pressing it.
  await chevron.evaluate(el => {
    const rect = el.getBoundingClientRect();
    scrollBy({top: rect.bottom - document.documentElement.clientHeight + 2, behavior: 'instant'});
  });
  const standing = () => chevron.evaluate(el => {
    const r = el.getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, scroll: scrollY, history: history.length,
      width: innerWidth, height: innerHeight};
  });
  const at = await standing();
  expect(at.y).toBeGreaterThan(520);
  expect(at.y).toBeLessThan(568);
  await page.touchscreen.tap(at.x, at.y);
  await expect(chevron).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('menuitem', {name: 'View on Remote'})).toBeFocused();
  await expect(app.main).toHaveAttribute('data-place', 'home');
  expect(await standing()).toEqual(at);
  expect(await menu.evaluate(el => [...el.querySelectorAll('[role="menuitem"]')]
    .every(item => item.scrollWidth <= item.clientWidth))).toBe(true);
  const box = (await menu.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThan(at.top);
  expect(box.x + box.width).toBeLessThanOrEqual(320);

  // The key still sits under the hand. Opening a second time and dismissing from the keyboard keeps its focus.
  await page.touchscreen.tap(at.x, at.y);
  await expect(menu).toBeHidden();
  await chevron.press('Enter');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(chevron).toBeFocused();
  // A key's brief press feedback is not a jump of the document; compare its standing geometry.
  await expect.poll(standing).toEqual(at);
  await row.locator('.card-open').tap();
  await expect(app.main).toHaveAttribute('data-place', 'forge');
  await expect(app.forge.editor('README.md')).toBeVisible();
});
