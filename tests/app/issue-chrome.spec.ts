import {expect, test} from './fixtures.ts';

test('Issues has a desk\'s band (>_ and the search) and its first action open, as Forge has', async ({signedIn: app}) => {
  await app.rail.go('git');
  await expect(app.main.locator('.band-bench .search-in')).toBeVisible();
  // (All desk: no pane beside it, and nothing that puts one away.)
  await expect(app.main.locator('.band-bench > .side')).toHaveCount(0);
  await expect(app.main.locator('.pane-toggle')).toHaveCount(0);
  const first = app.main.locator('button.issue-new');
  await expect(first).toBeVisible();
  await expect(first).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  await first.click();
  await expect(app.page.getByRole('button', {name: 'Create', exact: true})).toBeVisible();
  await app.rail.go('forge');
  await expect(app.main.locator('.forge-first')).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  await expect(app.main.locator('.desk-bench .search-in')).toBeVisible();
  await expect(app.main.locator('.desk-bench .pane-toggle')).toHaveCount(0);
});

test('Issues\' reference is its band\'s search: what it shows comes down under the band and goes with Escape, come to from Forge too', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.newRepo.openInForge();
  await expect(app.main.locator('.desk-bench > .side')).toHaveCount(0);
  await app.rail.go('git');
  await app.forge.show('Issue');
  await expect(app.forge.results).toContainText('No issues yet');
  await app.page.keyboard.press('Escape');
  await expect(app.forge.results).toBeHidden();
  // Left with it down, it is not there in Forge.
  await app.forge.show('Issue');
  await expect(app.forge.results).toBeVisible();
  await app.rail.go('forge');
  await expect(app.forge.results).toBeHidden();
  await expect(app.main.locator('.desk-bench .search-in')).toBeVisible();
});
