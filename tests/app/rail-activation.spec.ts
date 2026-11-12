import {expect, test} from './fixtures.ts';

test('a cancelled rail press does not swallow the next Enter or Space activation', async ({app}) => {
  const runtime = app.page.locator('#purpose-runtime');
  const home = app.page.locator('#purpose-home');
  for (const key of ['Enter', 'Space']) {
    await runtime.dispatchEvent('pointerdown', {pointerType: 'mouse', pointerId: 1, button: 0});
    await runtime.dispatchEvent('pointercancel', {pointerType: 'mouse', pointerId: 1});
    await home.click();
    await expect(home).toHaveAttribute('aria-current', 'page');
    await runtime.focus();
    await runtime.press(key);
    await expect(runtime).toHaveAttribute('aria-current', 'page');
  }
});
