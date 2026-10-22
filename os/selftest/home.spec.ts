import type {Locator} from '@playwright/test';
import {expect, test} from './fixtures.ts';

// Home's TODO: a first line named like an issue (Kind：title), Enter for the
// detail, Enter on an empty line for the next item; done strikes the first
// line through.

test('a TODO is written as Kind: title, Enter for its detail, and done strikes it', async ({app}) => {
  await app.rail.go('home');
  const item = app.home.items.first();

  await app.home.title(item).fill('Fix: The tent leaks');
  // "Fix：" is taken as its kind; the title is what follows.
  await expect(item).toContainText('Fix：');
  await expect(app.home.title(item)).toHaveValue('The tent leaks');
  await expect(app.home.todo).toContainText('1 of 1 left');

  await app.home.title(item).press('Enter');
  await expect(app.home.detail(item)).toBeFocused();
  await app.home.detail(item).pressSequentially('Seam by the door');
  // Enter on an empty line ends the item and starts the next.
  await app.home.detail(item).press('Enter');
  await app.home.detail(item).press('Enter');
  await expect(app.home.title(app.home.items.nth(1))).toBeFocused();
  await expect(app.home.detail(item)).toHaveValue('Seam by the door');

  await app.home.mark(item).click();
  await expect(app.home.mark(item)).toHaveAttribute('aria-pressed', 'true');
  await expect(app.home.title(item)).toHaveCSS('text-decoration-line', 'line-through');
  await expect(app.home.todo).toContainText('0 of 1 left');
});

test("a TODO's detail starts on its first line's column, with a kind and without", async ({app}) => {
  await app.rail.go('home');
  const left = async (l: Locator) => (await l.boundingBox())!.x;
  const kinded = app.home.items.first();
  await app.home.title(kinded).fill('Fix: The tent leaks');
  await app.home.title(kinded).press('Enter');
  await app.home.detail(kinded).pressSequentially('Seam by the door');
  await app.home.detail(kinded).press('Enter');
  await app.home.detail(kinded).press('Enter');
  const plain = app.home.items.nth(1);
  await app.home.title(plain).pressSequentially('Buy pegs');
  await app.home.title(plain).press('Enter');
  await app.home.detail(plain).pressSequentially('Eight of them');
  // The first line starts with the kind where there is one, else with the title; the detail starts there too.
  expect(Math.abs(await left(app.home.detail(kinded)) - await left(kinded.getByText('Fix：')))).toBeLessThan(1);
  expect(Math.abs(await left(app.home.detail(plain)) - await left(app.home.title(plain)))).toBeLessThan(1);
});

test("Home's repos are three across at a laptop's width, and one under another on a phone", async ({app}) => {
  for (const name of ['notes', 'trip', 'site']) await app.newRepo.make(name);
  await app.rail.go('home');
  // The three, then New repo.
  const repos = app.main.getByRole('region', {name: 'Repos'});
  const cards = repos.getByRole('group').or(repos.getByRole('button', {name: 'New repo'}));
  await expect(cards).toHaveCount(4);
  const tops = async () => Promise.all((await cards.all()).map(async (c) => Math.round((await c.boundingBox())!.y)));
  await app.page.setViewportSize({width: 1180, height: 800});
  await expect(async () => {
    const y = await tops();
    expect(y.slice(0, 3).every((v) => v === y[0])).toBe(true);
    expect(y[3]).toBeGreaterThan(y[0]);
  }).toPass();
  await app.page.setViewportSize({width: 390, height: 844});
  await expect(async () => expect(new Set(await tops()).size).toBe(4)).toPass();
});
