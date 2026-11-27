import {expect, test} from './fixtures.ts';

test('Git and Forge have one Places key and a direct first action, with no permanent toolbar beside the desk', async ({signedIn: app}) => {
  const {main, page} = app;
  const rail = page.getByRole('navigation', {name: 'Purposes', exact: true});
  await app.rail.go('git');
  await expect(main.getByRole('heading', {name: 'Git', exact: true})).toBeVisible();
  await expect(app.forge.placesKey).toHaveAttribute('aria-expanded', 'false');
  await expect(rail).toBeHidden();
  await expect(app.rail.door).toBeHidden();
  await expect(main.locator('.band-bench .band-tools')).toHaveCSS('opacity', '0');
  await expect(main.locator('.band-bench > .side, .pane-toggle')).toHaveCount(0);
  const first = main.getByRole('button', {name: /^Create your first repo/});
  await expect(first).toBeVisible();
  await expect(first).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  await first.click();
  await expect(main.getByRole('button', {name: 'Create', exact: true})).toBeVisible();

  await app.rail.go('forge');
  await expect(main.getByRole('heading', {name: 'Forge', exact: true})).toBeVisible();
  await expect(app.forge.placesKey).toHaveAttribute('aria-expanded', 'false');
  await expect(rail).toBeHidden();
  await expect(app.rail.door).toBeHidden();
  await expect(app.forge.search).toBeHidden();
  await expect(main.locator('.desk-bench > .side, .pane-toggle')).toHaveCount(0);
  const open = main.getByRole('button', {name: 'Open Folder', exact: true});
  await expect(open).toBeVisible();
  await expect(open).toHaveCSS('border-top-width', '0px');
  await open.click();
  const chooser = page.getByRole('dialog', {name: 'Open Folder', exact: true});
  await expect(chooser.getByRole('button', {name: 'Create your first repo', exact: true})).toBeVisible();
  await chooser.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(chooser).toBeHidden();
  await expect(open).toBeFocused();
});

test('Git summons a real search by its shortcut; Escape puts it away and Forge does not inherit it', async ({signedIn: app}) => {
  const {main, page, forge} = app;
  await app.newRepo.make('hello');
  await app.newRepo.openInForge();
  await expect(main.locator('.desk-bench > .side')).toHaveCount(0);

  await app.rail.go('git');
  const gitSearch = main.locator('.git-layout .band-tools');
  await expect(gitSearch).toHaveCSS('opacity', '0');
  const rail = page.getByRole('navigation', {name: 'Purposes', exact: true});
  await expect(main.getByRole('button', {name: 'Search', exact: true})).toBeVisible();
  // The corner opens even with no repo. The inline shortcut uses Git's own repo once it is read.
  await expect(forge.search).toBeEnabled();
  await main.getByRole('region', {name: 'Git', exact: true}).press('Control+k');
  await expect(forge.search).toBeFocused();
  await expect(rail).toBeHidden();
  await expect(gitSearch).toHaveCSS('opacity', '1');
  await forge.find('hello');
  await expect(forge.results).toContainText('README.md');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(forge.results).toBeHidden();
  await expect(gitSearch).toHaveCSS('opacity', '0');

  // Leave Git with results open, through its actual corner menu. Forge opens on its own desk.
  await page.keyboard.press('/');
  await expect(forge.search).toBeFocused();
  await forge.find('hello');
  await expect(forge.results).toContainText('README.md');
  await app.rail.go('forge');
  await expect(forge.results).toBeHidden();
  await expect(forge.search).toBeHidden();

  // Forge still has the same actual search on demand.
  await page.keyboard.press('Control+k');
  await expect(forge.search).toBeFocused();
  await forge.find('hello');
  await expect(forge.results).toContainText('README.md');
});
