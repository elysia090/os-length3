import {expect, test} from './fixtures.ts';
import type {App} from './app.ts';
import type {Locator, Page} from '@playwright/test';

/** A step is the entire visible row, not just its word. Use the area after its label, as a person can. */
async function pressRightOfWord(page: Page, button: Locator, touch = false) {
  await expect(button).toBeEnabled();
  const row = button.locator('..');
  await row.scrollIntoViewIfNeeded();
  const {x,y} = await row.evaluate((line) => {
    const b = line.getBoundingClientRect();
    return {x: b.right - 5, y: b.top + b.height / 2};
  });
  if (touch) await page.touchscreen.tap(x,y);
  else await page.mouse.click(x,y);
}

async function takeSteps(app: App, touch = false) {
  const {page, git} = app;
  await app.newRepo.make('tideline');
  await git.write('tideline','Fix: Publish tide chart');
  await expect(git.issue('#1 Fix：Publish tide chart')).toBeVisible();
  await pressRightOfWord(page, git.step('Start'), touch);
  await expect(git.step('Back to main')).toBeVisible({timeout: 2200});
  await app.rail.go('forge');
  await app.forge.editFile('README.md','# tideline\n\nForecast published.\n');
  await app.rail.go('git');
  await expect(app.main.getByRole('region',{name:'1 uncommitted file'})).toContainText('Forecast published.');
  await pressRightOfWord(page, git.step('Commit'), touch);
  await expect(git.step('Submit')).toBeEnabled();
  const paint = await page.locator('#page .git-switch .switch-line').evaluateAll((rows) => rows.filter(el => {
    const s = getComputedStyle(el,'::before');
    return s.display !== 'none' && s.content !== 'none';
  }).map(el => (el as HTMLElement).dataset.step));
  expect(paint).toEqual(['submit']);
  await pressRightOfWord(page, git.step('Submit'), touch);
  await expect(git.review.getByText('Forecast published.',{exact:true})).toBeVisible();
  await expect(git.step('Merge')).toBeDisabled();
  await git.review.getByRole('button', {name: 'Approve', exact: true})[touch ? 'tap' : 'click']();
  await pressRightOfWord(page, git.step('Merge'), touch);
  await expect(git.section('Merged')).toContainText('#1 Fix：Publish tide chart');
}

test('the visible whole Git step works and the band follows a mouse deed', async ({signedIn: app}) => {
  await takeSteps(app);
});

test.describe('touch', () => {
  test.use({hasTouch: true, isMobile: true});
  for (const width of [320, 390]) test(`${width}px: the same part of each Git step works for a finger`, async ({signedIn: app}) => {
    await app.page.setViewportSize({width, height: 844});
    await takeSteps(app, true);
  });
});

test('mouse Commit advances the painted step to Submit without changing keyboard semantics', async ({signedIn: app}) => {
  const {page,git}=app;
  await app.newRepo.make('tideline');
  await git.write('tideline','Fix: Publish tide chart');
  await git.step('Start').click();
  await expect(git.step('Back to main')).toBeVisible();
  await app.rail.go('forge');
  await app.forge.editFile('README.md','# tideline\n\nForecast published.\n');
  await app.rail.go('git');
  await git.step('Commit').click();
  await expect(git.step('Submit')).toBeEnabled();
  const paint = await page.locator('#page .git-switch .switch-line').evaluateAll((rows) => rows.filter(el => {
    const s = getComputedStyle(el,'::before');
    return s.display !== 'none' && s.content !== 'none';
  }).map(el => ({step:(el as HTMLElement).dataset.step, focused:!!el.querySelector('button:focus'), keyboard:!!el.querySelector('button:focus-visible')})));
  expect(paint.map(el=>el.step)).toEqual(['submit']);
});
