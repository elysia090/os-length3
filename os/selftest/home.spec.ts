import type {Locator} from '@playwright/test';
import {expect, test} from './fixtures.ts';

// Home's TODO: a first line named like an issue (Kind：title), Enter for the
// detail, Enter on an empty line for the next item; done strikes the first
// line through.

test('a TODO is written as Kind: title, Enter for its detail, and done strikes it', async ({app}) => {
  await app.rail.go('home');
  const item = app.home.items.first();

  // Typed key by key, as a person does: "Fix：" is taken as its kind the moment its colon is, and the space after it
  // goes with it; the title is what follows, from its first word.
  await app.home.title(item).pressSequentially('Fix: The tent leaks');
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
  // Struck through: a line drawn across its words, from its kind's start to the title's end, and no further.
  const strike = item.locator('.todo-strike');
  await expect(strike).toHaveCSS('scale', '1');
  const [line, kind, title] = await Promise.all([strike, item.locator('.todo-kind'), app.home.title(item)].map((l) => l.boundingBox()));
  expect(Math.abs(line!.x - kind!.x)).toBeLessThan(1.5);
  expect(line!.x + line!.width).toBeGreaterThan(title!.x + 60);
  expect(line!.x + line!.width).toBeLessThan(title!.x + title!.width);
  await expect(app.home.todo).toContainText('0 of 1 left');
});

test('a TODO item begun and left empty goes as the keyboard leaves it', async ({app}) => {
  await app.rail.go('home');
  const item = app.home.items.first();
  await app.home.title(item).pressSequentially('Fix: one');
  // Enter twice: the detail, then the next item, begun and left with nothing in it.
  await app.home.title(item).press('Enter');
  await app.home.detail(item).press('Enter');
  await expect(app.home.title(app.home.items.nth(1))).toBeFocused();
  await expect(app.home.items).toHaveCount(3);
  await app.main.getByRole('heading', {level: 1}).click();
  // Left, it goes: the one written and the empty line at the foot to write the next in.
  await expect(app.home.items).toHaveCount(2);
  await expect(app.home.title(app.home.items.nth(1))).toHaveValue('');
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

test('the name written on Home is the account\'s, so what is started, committed and reviewed from here says it', async ({signedIn: app}) => {
  await app.rail.go('home');
  await app.main.getByRole('button', {name: 'Edit profile'}).click();
  const name = app.page.locator('#profile-name');
  await name.fill('Ada Byron');
  await name.press('Enter');
  await expect(app.main.getByRole('button', {name: 'Edit profile'})).toBeVisible();
  await expect(app.main.getByRole('heading', {name: 'Ada Byron', level: 1})).toBeVisible();
  // The Remote knows the person by it now.
  await app.rail.go('remote');
  await expect(app.main.getByText('Signed in as Ada Byron')).toBeVisible();
});

test.describe("on 'hello', made from C's files and worked in last", () => {
  // Made once for the worker and kept (fixtures.ts, helloC), as making it is new-repo.spec.ts's and file.spec.ts's to see.
  test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

  test('Home has the search Forge has, where Forge has it: in the repo last worked in, a line found opened in Forge there', async ({app}) => {
    await app.rail.go('home');
    // Named, there being no band on Home to say which repo it searches.
    const search = app.main.getByRole('searchbox', {name: 'Search hello'});
    await expect(search).toBeVisible();
    await app.page.keyboard.press('Control+k');
    await expect(search).toBeFocused();
    await search.fill('puts');
    const results = app.main.getByRole('region', {name: 'Search results'});
    await expect(results.getByText('1 file · 1 line')).toBeVisible();
    await results.getByRole('button', {name: /puts\("hello"\);/}).click();
    await expect(app.forge.editor('src/main.c')).toBeFocused();
    await expect.poll(() => app.forge.selected('src/main.c')).toBe('    puts("hello");');
  });
});

test('Home come back to is where it was read to, and the page between starts at its top', async ({app}) => {
  await app.page.setViewportSize({width: 1280, height: 420});
  await app.rail.go('home');
  const read = () => app.page.evaluate(() => Math.round(document.scrollingElement!.scrollTop));
  await app.page.evaluate(() => { document.scrollingElement!.scrollTop = 200; });
  await expect.poll(read).toBe(200);
  await app.rail.go('runtime');
  await expect.poll(read).toBe(0);
  await app.rail.go('home');
  await expect.poll(read).toBe(200);
});
