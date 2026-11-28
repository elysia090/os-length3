import {join} from 'node:path';
import {expect, test} from './fixtures.ts';
import {devices, type Page} from '@playwright/test';

const pages = ['Home', 'Forge', 'Git', 'Server', 'Inbox', 'Runtime'];
const sample = '\n# hello\nA small interpreter for a language that fits in one file.\n\nThe interpreter writes its result to standard output.\n';
const save = async (page: Page, name: string) => {
  if (process.env.PLACES_CAPTURE) await page.screenshot({path: join(process.env.PLACES_CAPTURE, name + '.png'), scale: 'css'});
};

test('Places keeps the title still, shows the six radio rows, and jumps once with browser Back', async ({app}) => {
  const {page, forge} = app;
  await page.setViewportSize({width: 1536, height: 864});
  await app.newRepo.make('hello');
  await forge.editor('README.md').fill(sample);
  const key = forge.placesKey, menu = forge.places, at = page.locator('#page');
  const label = key.locator('.places-label');
  await expect(key).toHaveAccessibleName('Forge');
  const spot = await label.boundingBox();
  const length = await page.evaluate(() => history.length);
  await page.mouse.move(1000, 120);
  await save(page, 'desktop-closed');
  await key.click();
  const rows = menu.getByRole('menuitemradio');
  await expect(rows).toHaveText(pages);
  const here = rows.nth(1);
  await expect(here).toBeFocused();
  await expect(here).toHaveAttribute('aria-checked', 'true');
  await expect(menu.locator('[aria-checked=true]')).toHaveCount(1);
  expect(await label.boundingBox()).toEqual(spot);
  expect((await menu.boundingBox())!.y).toBeGreaterThan((await key.boundingBox())!.y);
  const veil = key.locator('..').locator(':scope > .page-veil.places-veil');
  await expect(veil).toHaveAttribute('aria-hidden', 'true');
  await expect(veil).toBeVisible();
  await expect(veil).toHaveCSS('backdrop-filter', 'blur(6px)');
  expect(await menu.evaluate(el => getComputedStyle(el).filter)).toBe('none');
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page.mouse.move(1000, 120);
  await save(page, 'desktop-open');

  await page.keyboard.press('End');
  await expect(rows.last()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(key).toBeFocused();
  await expect(menu).toBeHidden();
  await expect(veil).toBeHidden();
  await key.click();
  await page.mouse.click(1000, 120);
  await expect(menu).toBeHidden();
  await expect(key).toBeFocused();

  await key.click();
  await rows.last().click();
  await expect(at).toHaveAttribute('data-place', 'runtime');
  await expect(key).toHaveAccessibleName('Runtime');
  await expect(key).toBeFocused();
  await expect(menu).toBeHidden();
  await expect(page.locator('.place-left')).toHaveCount(0);
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  await page.mouse.move(1000, 120);
  await save(page, 'desktop-chosen');
  await page.goBack();
  await expect(at).toHaveAttribute('data-place', 'forge');
  await expect(key).toBeFocused();
  await expect(forge.editor('README.md')).toHaveValue(sample);

  await key.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(at).toHaveAttribute('data-place', 'git');
  await expect(key).toBeFocused();
  await key.press('Enter');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(at).toHaveAttribute('data-place', 'forge');
  await expect(key).toBeFocused();

  // On a wide Forge desk the existing Prompt entry point still opens the contextual tool.
  const prompt = at.locator('.forge-prompt-approach');
  await expect(prompt).toBeVisible();
  await prompt.click();
  await expect(at.locator('.desk-room[data-prompt-open]')).toBeVisible();
  await prompt.click();

  // Search keeps its original, independent entry point; opening it never changes the six page destinations.
  await key.click();
  const lens = page.getByRole('button', {name: 'Search', exact: true});
  await lens.click();
  await expect(page.getByRole('main', {name: 'Search', exact: true}).getByRole('searchbox')).toBeFocused();
  await expect(menu).toBeHidden();
});

test.describe('390px Android Chromium touch emulation', () => {
  test.use({userAgent: devices['Pixel 7'].userAgent, deviceScaleFactor: devices['Pixel 7'].deviceScaleFactor,
    hasTouch: true, isMobile: true, viewport: {width: 390, height: 844}, reducedMotion: 'no-preference'});

  test('tap chooses directly, a touch on the same key swipes one page, and the editor is not a nav surface', async ({app}) => {
    const {page, forge} = app;
    await app.newRepo.make('hello');
    await forge.editor('README.md').fill(sample);
    const key = forge.placesKey, menu = forge.places, at = page.locator('#page'), left = page.locator('.place-left');
    await expect(left).toHaveCount(0);
    await key.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
    await save(page, '390-closed');
    const spot = (await key.locator('.places-label').boundingBox())!;
    await key.tap();
    const rows = menu.getByRole('menuitemradio');
    await expect(rows).toHaveText(pages);
    expect(await key.locator('.places-label').boundingBox()).toEqual(spot);
    for (const row of await rows.all()) {
      await expect(row).toBeInViewport({ratio: 1});
      expect((await row.boundingBox())!.height).toBe(44);
    }
    await save(page, '390-open');
    await rows.last().tap();
    await expect(at).toHaveAttribute('data-place', 'runtime');
    await expect(left).toHaveCount(0);
    await expect(key).toBeFocused();
    await expect(menu).toBeHidden();
    await save(page, '390-chosen');
    await page.goBack();
    await expect(at).toHaveAttribute('data-place', 'forge');
    await expect(key).toBeFocused();
    await expect(left).toHaveCount(0);

    const cdp = await page.context().newCDPSession(page);
    const swipe = async (x: number, y: number, dx: number, dy = 0) => {
      await cdp.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: [{x, y}]});
      for (let i = 1; i <= 5; i++)
        await cdp.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: [{x: x + i * dx / 5, y: y + i * dy / 5}]});
      await cdp.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    };
    const state = () => page.evaluate(() => ({history: history.length, place: history.state.place}));
    const start = await state();
    const b = (await key.boundingBox())!;
    await swipe(Math.round(b.x + b.width - 5), Math.round(b.y + b.height / 2), -48);
    await expect(at).toHaveAttribute('data-place', 'git');
    // Freeze the app's own outgoing and incoming transitions for one still while both are in flight.
    const motion = await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      const moves = document.getAnimations().filter((a) => a.effect instanceof KeyframeEffect &&
        a.effect.getKeyframes().some(frame => String(frame.transform).includes('translateX(')));
      for (const move of moves) {
        const duration = Number(move.effect!.getComputedTiming().duration);
        move.pause();
        move.currentTime = Math.round(duration * .20);
      }
      return {
        outgoing: moves.filter(x => (x.effect as KeyframeEffect).target?.closest('.place-left')).length,
        incoming: moves.filter(x => (x.effect as KeyframeEffect).target?.closest('#page[data-place="git"]')).length,
        header: moves.some(x => (x.effect as KeyframeEffect).target?.matches('.desk-caption, .desk-caption *')),
      };
    });
    expect(motion.outgoing).toBe(1);
    expect(motion.incoming).toBeGreaterThan(0);
    expect(motion.header).toBe(false);
    const settledHeader = (await key.locator('.places-label').boundingBox())!;
    expect([settledHeader.x, settledHeader.y]).toEqual([spot.x, spot.y]);
    await save(page, '390-swipe-in-flight');
    await page.evaluate(() => { for (const a of document.getAnimations()) if (a.playState === 'paused') a.play(); });
    await expect(key).toHaveAccessibleName('Git');
    await expect(key).toBeFocused();
    await expect(menu).toBeHidden();
    expect((await state()).history).toBe(start.history); // the previous forward entry was replaced by this one step
    await expect(left).toHaveCount(0);
    await save(page, '390-swipe-next');
    await page.goBack();
    await expect(at).toHaveAttribute('data-place', 'forge');
    await expect(left).toHaveCount(0);
    const back = (await key.boundingBox())!;
    await swipe(Math.round(back.x + 18), Math.round(back.y + back.height / 2), 55);
    await expect(at).toHaveAttribute('data-place', 'home');
    await expect(key).toHaveAccessibleName('Home');
    await expect(menu).toBeHidden();
    await expect(left).toHaveCount(0);
    await page.goBack();
    await expect(at).toHaveAttribute('data-place', 'forge');
    await expect(left).toHaveCount(0);
    const edit = (await forge.editor('README.md').boundingBox())!;
    await swipe(Math.round(edit.x + Math.min(120, edit.width / 2)), Math.round(edit.y + 14), -54);
    await expect(at).toHaveAttribute('data-place', 'forge');
    await expect(menu).toBeHidden();
    const vertical = (await key.boundingBox())!;
    await swipe(Math.round(vertical.x + 18), Math.round(vertical.y + 20), 0, 76);
    await expect(at).toHaveAttribute('data-place', 'forge');
    await expect(menu).toBeHidden();
    expect(await page.evaluate(() => visualViewport!.scale)).toBe(1);
  });
});
