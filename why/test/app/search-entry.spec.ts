import {expect, test} from './fixtures.ts';
import type {App} from './app.ts';

const desks = ['home', 'forge', 'git', 'inbox', 'runtime'] as const;

async function paired(app: App) {
  const search = app.main.getByRole('button', {name: 'Search', exact: true});
  const places = app.forge.placesKey;
  await expect(search).toHaveCount(1);
  await expect(places).toHaveCount(1);
  // Startup mounts the controls before the complete first page becomes visible.
  await expect(search).toBeVisible();
  await expect(places).toBeVisible();
  const [a, b] = await Promise.all([search.boundingBox(), places.boundingBox()]);
  expect(a).toEqual({x: b!.x - 44, y: b!.y, width: 44, height: 44});
  expect(await search.evaluate(key => getComputedStyle(key).color)).toBe(await places.evaluate(key => getComputedStyle(key).color));
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

test('the scope is an actual repo, even on a desk that had no repo in hand', async ({signedIn: app}) => {
  const {page, forge} = app;
  await app.newRepo.make('search-entry-scope');
  await forge.editFile('README.md', '# Example\n\nCorner lens finds this unique text.\n');
  await app.rail.go('runtime');
  // Runtime may be restored after reload even if the device has no saved current repo.
  await page.evaluate(() => localStorage.removeItem('why.os.repo'));
  await page.reload();
  await expect(page.locator('#page')).toHaveAttribute('data-place', 'runtime');
  const search = await paired(app);
  await search.press('Enter');
  const stage = page.getByRole('main', {name: 'Search', exact: true});
  const scope = stage.getByRole('combobox', {name: 'Search in'}), input = stage.getByRole('searchbox');
  await expect(scope).toHaveValue('search-entry-scope');
  await expect(input).toBeFocused();
  await input.fill('unique text');
  await expect(stage.getByRole('button', {name: 'Corner lens finds this unique text.'})).toBeVisible();
  await stage.getByRole('button', {name: 'Back', exact: true}).click();
  await expect(stage).toHaveCount(0);
  await expect(search).toBeFocused();

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
