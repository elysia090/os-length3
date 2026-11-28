import {expect, test} from './fixtures.ts';
import type {App} from './app.ts';
import type {Route} from '@playwright/test';

const desks = ['home', 'forge', 'git', 'inbox', 'runtime'] as const;

async function paired(app: App) {
  const search = app.main.getByRole('button', {name: 'Search', exact: true});
  const places = app.forge.placesKey;
  await expect(search).toHaveCount(1);
  await expect(places).toHaveCount(1);
  // Startup mounts the controls before the complete first page becomes visible.
  await expect(search).toBeVisible();
  await expect(places).toBeVisible();
  const width = await app.page.evaluate(() => innerWidth);
  await expect(async () => {
    const [a, b] = await Promise.all([search.boundingBox(), places.locator('.places-label').boundingBox()]);
    expect(a).toEqual({x: width - 56, y: 12, width: 44, height: 44});
    expect(b && [b.x, b.y]).toEqual([width <= 1000 ? 24 : 48, 24]);
  }).toPass({timeout: 5000});
  // Git's keyboard Reference may be in the tab order at opacity zero; the desk has no always-visible search bar.
  expect(await app.main.getByRole('searchbox').evaluateAll(fields => fields.some(field =>
    field.checkVisibility({opacityProperty: true, visibilityProperty: true})))).toBe(false);
  return search;
}

test('the same corner Search works before a repo exists, without taking away any desk', async ({signedIn: app}) => {
  const {page} = app;
  await page.setViewportSize({width: 1320, height: 792});
  const stage = page.getByRole('main', {name: 'Search', exact: true});
  for (const place of desks) {
    await app.rail.go(place);
    await expect(page.locator('#page')).toHaveAttribute('data-place', place);
    const search = await paired(app);
    const before = page.url();
    await search.focus();
    await page.keyboard.press('Enter');
    const input = stage.getByRole('searchbox');
    await expect(input).toBeFocused();
    const veil = page.locator('.search-veil.out');
    if (place === 'home') await expect(veil).toHaveCount(0);
    // Other desks keep their veil in the shared dark ground, even when the body has the old light token.
    else await expect(veil).toHaveCSS('--ground', '#3a3d36');
    await expect(stage.getByRole('search')).toHaveCSS('--paper', '#1a272d');
    await expect(input).toHaveAttribute('placeholder', 'No repo to search');
    await expect(stage.getByRole('combobox', {name: 'Search in'})).toHaveCount(0);
    await expect(stage.getByRole('button', {name: 'Search', exact: true})).toHaveCount(0);
    expect(page.url()).toBe(before);
    await input.fill('The only Search');
    await expect(stage.getByRole('status')).toHaveText('No repo to search');
    if (place === 'runtime') await stage.getByRole('button', {name: 'Back', exact: true}).click();
    else await input.press('Escape');
    await expect(stage).toHaveCount(0);
    await expect(search).toBeFocused();
  }
});

test('the restored Runtime corner opens Search during startup without an account or a repo', async ({app}) => {
  const {page} = app;
  await app.rail.go('runtime');
  await page.reload();
  await expect(page.locator('#page')).toHaveAttribute('data-place', 'runtime');
  const search = await paired(app);
  await search.press('Enter');
  const stage = page.getByRole('main', {name: 'Search', exact: true});
  await expect(stage.getByRole('searchbox')).toBeFocused();
  await expect(stage.getByRole('searchbox')).toHaveAttribute('placeholder', 'No repo to search');
  await expect(page.locator('#page')).not.toHaveAttribute('aria-busy', 'true');
  await expect(stage.getByRole('combobox', {name: 'Search in'})).toHaveCount(0);
  await stage.getByRole('button', {name: 'Back', exact: true}).click();
  await expect(stage).toHaveCount(0);
  await expect(search).toBeFocused();
  await expect(app.main.getByRole('region', {name: 'In this browser'}).getByText('Other (estimated)', {exact: true})).toBeVisible();
});

test('the scope is an actual repo, even on a desk that had no repo in hand', async ({signedIn: app}) => {
  const {page, forge} = app;
  await app.newRepo.make('search-entry-scope');
  await forge.editFile('README.md', '# Example\n\nCorner lens finds this unique text.\n');
  await app.rail.go('runtime');
  // Runtime may be restored after reload even if the device has no saved current repo.
  await page.evaluate(() => localStorage.removeItem('why.os.repo'));
  // Keep the first Remote look pending until the keyboard has already taken up the visible corner key.
  const pending = Promise.withResolvers<void>();
  let waiting = false;
  const firstLook = async (route: Route) => { waiting = true; await pending.promise; await route.continue(); };
  await page.route('**/v1/moved', firstLook);
  const search = app.main.getByRole('button', {name: 'Search', exact: true});
  try {
    await page.reload();
    await expect(page.locator('#page')).toHaveAttribute('data-place', 'runtime');
    await expect.poll(() => waiting).toBe(true);
    await expect(page.locator('#page')).toHaveAttribute('aria-busy', 'true');
    await paired(app);
    await search.focus();
    await expect(search).toBeFocused();
    pending.resolve();
    await app.settled();
    await expect(search).toBeFocused();
    await page.keyboard.press('Enter');
  } finally {
    pending.resolve();
    await page.unroute('**/v1/moved', firstLook);
  }
  const stage = page.getByRole('main', {name: 'Search', exact: true});
  const scope = stage.getByRole('combobox', {name: 'Search in'}), input = stage.getByRole('searchbox');
  await expect(scope).toHaveValue('search-entry-scope');
  await expect(input).toBeFocused();
  await input.fill('unique text');
  await expect(stage.getByRole('button', {name: 'Corner lens finds this unique text.'})).toBeVisible();
  await stage.getByRole('button', {name: 'Back', exact: true}).click();
  await expect(stage).toHaveCount(0);
  await expect(search).toBeFocused();
  await expect(app.main.getByRole('region', {name: 'In this browser'}).getByRole('button', {name: 'search-entry-scope', exact: true})).toBeVisible();

  await app.inbox.named();
  await page.setViewportSize({width: 390, height: 844});
  const narrowSearch = await paired(app);
  const [entry, newMessage] = await Promise.all([narrowSearch.boundingBox(), app.inbox.newMessage.boundingBox()]);
  expect(newMessage!.x + newMessage!.width).toBeLessThanOrEqual(entry!.x);
  // The keyboard was on the lens when Search opened, so Escape gives it back to the lens.
  await narrowSearch.press('Enter');
  await expect(scope).toHaveValue('search-entry-scope');
  await expect(input).toBeFocused();
  await input.press('Escape');
  await expect(stage).toHaveCount(0);
  await expect(narrowSearch).toBeFocused();

  // A mouse takes Search from the paper in hand, not from the lens it presses.
  await app.inbox.newMessage.click();
  const address = app.inbox.recipient.getByRole('textbox', {name: 'Recipient address'});
  await expect(address).toBeFocused();
  await address.fill('mira');
  const writing = () => address.evaluate((el: HTMLInputElement) => [el.value, el.selectionStart, el.selectionEnd, el.selectionDirection]);
  await address.evaluate((el: HTMLInputElement) => el.setSelectionRange(1, 3, 'backward'));
  await narrowSearch.click();
  await expect(scope).toHaveValue('search-entry-scope');
  await expect(input).toBeFocused();
  await input.press('Escape');
  await expect(stage).toHaveCount(0);
  await expect(address).toBeFocused();
  expect(await writing()).toEqual(['mira', 1, 3, 'backward']);
});
