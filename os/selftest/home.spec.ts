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
  await expect(app.home.todo).toContainText('1 of 1 remaining');

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
  await expect(app.home.todo).toContainText('0 of 1 remaining');
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

test('a TODO item goes by its ×, or Delete on its empty line, and Clear completed takes the done ones', async ({app}) => {
  await app.rail.go('home');
  await app.home.title(app.home.items.first()).click();
  for (const line of ['Buy: seeds', 'Call: the plumber', 'Fix: the gate', 'Paint: the fence', 'Oil: the hinge']) {
    await app.page.keyboard.type(line);
    await app.page.keyboard.press('Enter');
    await app.page.keyboard.press('Enter');
  }
  // Left, the next begun and not written goes: the five, and the line at the foot.
  await app.main.getByRole('heading', {level: 1}).click();
  await expect(app.home.items).toHaveCount(6);
  // Its × is there for the item under the pointer, not the line still to be written.
  const second = app.home.items.nth(1);
  const away = second.getByRole('button', {name: 'Delete Call：the plumber'});
  await second.hover();
  await expect(away).toHaveCSS('opacity', '1');
  await expect(app.home.items.last().getByRole('button', {name: /^Remove/})).toBeHidden();
  await away.click();
  await expect(app.home.items).toHaveCount(5);
  await expect(app.home.title(app.home.items.nth(1))).toHaveValue('the gate');
  // The keyboard goes on to the × of the one that came up into its place, under the pointer: a double press takes one.
  const next = app.home.items.nth(1).getByRole('button', {name: 'Delete Fix：the gate'});
  await expect(next).toBeFocused();
  await app.page.waitForTimeout(600);
  await next.dblclick();
  await expect(app.home.items).toHaveCount(4);
  await expect(app.home.title(app.home.items.nth(1))).toHaveValue('the fence');

  // Delete on a line emptied of its words (its kind with it) takes it out, the caret going on to the next.
  const emptied = app.home.items.nth(1);
  await app.home.title(emptied).fill('');
  await app.home.title(emptied).press('Delete');
  await expect(app.home.items).toHaveCount(3);
  await expect(app.home.title(app.home.items.nth(1))).toHaveValue('the hinge');
  await expect(app.home.title(app.home.items.nth(1))).toBeFocused();

  // Clear completed is there while something is done, and takes the done ones together.
  const clear = app.home.todo.getByRole('button', {name: 'Clear completed'});
  await expect(clear).toBeHidden();
  await app.home.mark(app.home.items.first()).click();
  await clear.click();
  await expect(app.home.items).toHaveCount(2);
  await expect(app.home.title(app.home.items.first())).toHaveValue('the hinge');
  await expect(clear).toBeHidden();
  await expect(app.home.todo).toContainText('1 of 1 remaining');
  // Kept so: Home drawn again reads it as it was left.
  await app.rail.go('runtime');
  await app.rail.go('home');
  await expect(app.home.items).toHaveCount(2);
});

test('the empty line at the foot of the TODO is room for an item: its mark dashed, and no stop on the way', async ({app}) => {
  await app.rail.go('home');
  const item = app.home.items.first();
  await expect(app.home.title(item)).toHaveAttribute('placeholder', 'Fix: Task description');
  await expect(app.home.mark(item)).toBeDisabled();
  // Whole on a phone's line, not cut off as a title would be.
  await app.page.setViewportSize({width: 390, height: 844});
  await expect.poll(() => app.home.title(item).evaluate((el: HTMLInputElement) => {
    const pen = document.createElement('canvas').getContext('2d')!;
    const cs = getComputedStyle(el, '::placeholder');
    pen.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return pen.measureText(el.placeholder).width <= el.clientWidth;
  })).toBe(true);
  await app.page.setViewportSize({width: 1400, height: 900});
  // From Edit profile, Tab goes into the line to write in, not to a mark with nothing to mark.
  await app.main.getByRole('button', {name: 'Edit profile'}).focus();
  await app.page.keyboard.press('Tab');
  await expect(app.home.title(item)).toBeFocused();
  // Pressed, its dashed mark gives the caret Go to line; written in, it is an item, its mark whole.
  await app.main.getByRole('button', {name: 'Edit profile'}).focus();
  await app.home.mark(item).click({force: true});
  await expect(app.home.title(item)).toBeFocused();
  await app.home.title(item).pressSequentially('Buy pegs');
  await expect(app.home.mark(item)).toBeEnabled();
});

test('a Japanese kind is taken as a Latin one is, once the input method has given its word', async ({app}) => {
  await app.rail.go('home');
  const item = app.home.items.first();
  await app.home.title(item).click();
  // As an input method writes: the word being made is the method's (no kind is taken under it), then given.
  const cdp = await app.page.context().newCDPSession(app.page);
  await cdp.send('Input.imeSetComposition', {text: 'かう：', selectionStart: 3, selectionEnd: 3});
  await cdp.send('Input.imeSetComposition', {text: '買う：', selectionStart: 3, selectionEnd: 3});
  await expect(item.locator('.todo-kind')).toBeHidden();
  await cdp.send('Input.insertText', {text: '買う：'});
  await expect(item).toContainText('買う：');
  await expect(app.home.title(item)).toHaveValue('');
  await app.page.keyboard.insertText('種');
  await expect(app.home.title(item)).toHaveValue('種');
  // Set as Japanese sets it: the full-width colon, as written.
  await expect(item.locator('.todo-kind')).toHaveText('買う：');
  await expect(item.locator('.todo-kind .kind-colon')).toHaveCount(0);
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

test("Home's repos are a column of their names beside the TODO at a laptop's width, and under it on a phone", async ({app}) => {
  for (const name of ['notes', 'trip', 'site']) await app.newRepo.make(name);
  await app.rail.go('home');
  // The three, then New repo, one under another.
  const repos = app.main.getByRole('region', {name: 'Repos'});
  const cards = repos.getByRole('group').or(repos.getByRole('button', {name: 'New repo'}));
  await expect(cards).toHaveCount(4);
  const at = async (l: Locator) => (await l.boundingBox())!;
  await app.page.setViewportSize({width: 1180, height: 800});
  await expect(async () => {
    const boxes = await Promise.all((await cards.all()).map(at));
    expect(boxes.every((b, i) => i === 0 || b.y >= boxes[i - 1].y + boxes[i - 1].height - 1)).toBe(true);
    // Beside the TODO: to its right, from its top.
    const todo = await at(app.home.todo);
    expect(boxes[0].x).toBeGreaterThan(todo.x + todo.width);
    expect(Math.abs(boxes[0].y - todo.y)).toBeLessThan(80);
  }).toPass();
  await app.page.setViewportSize({width: 390, height: 844});
  await expect(async () => {
    const todo = await at(app.home.todo);
    expect((await at(cards.first())).y).toBeGreaterThan(todo.y + todo.height);
  }).toPass();
});

test('the name written on Home is the account\'s, so what is started, committed and reviewed from here says it', async ({signedIn: app}) => {
  await app.rail.go('home');
  await app.main.getByRole('button', {name: 'Edit profile'}).click();
  const name = app.page.locator('#profile-name');
  // None written yet, the name shown is the one signed in with, and the field opens on it to be changed.
  await expect(name).toHaveValue(app.person);
  await name.fill('Ada Byron');
  await name.press('Enter');
  await expect(app.main.getByRole('button', {name: 'Edit profile'})).toBeVisible();
  await expect(app.main.getByRole('heading', {name: 'Ada Byron', level: 1})).toBeVisible();
  // The Remote knows the person by it now.
  await app.rail.go('remote');
  await expect(app.main.getByText('Signed in as Ada Byron')).toBeVisible();
});

test('the handle on Home is the username: the one given at sign-in, and changed there it is changed for everyone', async ({signedIn: app}) => {
  await app.rail.go('home');
  await expect(app.main.locator('.identity .handle')).toHaveText(`@${app.handle}`);
  await app.main.getByRole('button', {name: 'Edit profile'}).click();
  const handle = app.main.getByRole('textbox', {name: 'Handle'});
  await expect(handle).toHaveValue(app.handle);
  const next = `${app.handle.slice(0, 26)}-home`;
  await handle.fill(`@${next}`);
  await handle.press('Enter');
  await expect(app.main.getByRole('button', {name: 'Edit profile'})).toBeVisible();
  await expect(app.main.locator('.identity .handle')).toHaveText(`@${next}`);
  // The Remote finds them by it now: Inbox's stub says it.
  await app.inbox.named(next);
  // One no username can be is said at the handle, and nothing is saved.
  await app.rail.go('home');
  await app.main.getByRole('button', {name: 'Edit profile'}).click();
  await handle.fill('-no');
  await handle.press('Enter');
  await expect(app.main.getByRole('alert')).toHaveText('Handle must be 2–31 lowercase letters, digits, or . - _');
  await expect(handle).toBeFocused();
});

test.describe("on 'hello', made from C's files and worked in last", () => {
  // Made once for the worker and kept (fixtures.ts, helloC), as making it is new-repo.spec.ts's and file.spec.ts's to see.
  test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

  test('Home has the search Forge has, where Forge has it: on the band, in the repo last worked in, a line found opened in Forge there', async ({app}) => {
    await app.rail.go('home');
    // Named, there being no repos on Home's band to say which it searches.
    const search = app.main.getByRole('searchbox', {name: 'Search hello'});
    await expect(search).toBeVisible();
    await app.page.keyboard.press('Control+k');
    await expect(search).toBeFocused();
    await search.fill('puts');
    // What it finds drops as a sheet over Home, as Forge's does over its desk, a kind at a time.
    const results = app.main.getByRole('region', {name: 'Search results'});
    await expect(results.locator('.found-sec-head')).toHaveText([/^files\s*1$/]);
    await results.getByRole('button', {name: /puts\("hello"\);/}).click();
    await expect(app.forge.editor('src/main.c')).toBeFocused();
    await expect.poll(() => app.forge.lineChosen('src/main.c')).toBe('    puts("hello");');
  });
});

test("Home's band has Forge's tools where Forge has them, and the pane's first row is level with the rail's first icon", async ({app}) => {
  await app.newRepo.make('notes');
  const tools = () => app.page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.band-tools > *')].filter((e) => e.getClientRects().length)
    .slice(0, 3).map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width)]; }));
  // The pane's first line and the rail's first icon start on one line (the bar beside the line starts with it), once
  // the first row is drawn and come to rest.
  const level = () => expect(async () => {
    const [line, bar] = await app.page.evaluate(() => {
      const row = [...document.querySelectorAll<HTMLElement>('.pane-row')].find((e) => e.getClientRects().length);
      const icon = document.querySelector('.rail svg')!.getBoundingClientRect().top;
      if (!row) return [NaN, NaN];
      return [row.querySelector('.pane-line')!.getBoundingClientRect().top - icon, row.querySelector('.pane-bar')!.getBoundingClientRect().top - icon];
    });
    expect(Math.abs(line)).toBeLessThan(1);
    expect(bar).toBeGreaterThan(2);
    expect(bar).toBeLessThan(7);
  }).toPass();
  await app.rail.go('forge');
  await app.forge.startPrompt('notes');
  await app.forge.run('true');
  await expect(app.forge.pane.locator('.pane-row.run')).toHaveCount(1);
  await level();
  const forge = await tools();
  await app.rail.go('home');
  await expect(async () => expect(await tools()).toEqual(forge)).toPass();
  await expect(app.main.getByRole('button', {name: 'Files: New, Rename, Delete'})).toBeVisible();
  await level();
  // Its files button is Forge's, for the repo last worked in: there, its menu out under Forge's own (the terminal in
  // hand there, the repo's deeds).
  await app.main.getByRole('button', {name: 'Files: New, Rename, Delete'}).click();
  const menu = app.page.getByRole('menu', {name: 'notes', exact: true});
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', {name: 'New file'})).toBeFocused();
  const under = (await app.forge.tools.getByRole('button', {name: 'Files: New, Rename, Delete'}).boundingBox())!;
  expect((await menu.boundingBox())!.y).toBeGreaterThan(under.y + under.height - 1);
});

test('Home come back to is where it was read to, and the page between starts at its top', async ({app}) => {
  await app.page.setViewportSize({width: 1280, height: 300});
  await app.rail.go('home');
  const read = () => app.page.evaluate(() => Math.round(document.scrollingElement!.scrollTop));
  // Read down to 120 px, once Home is that long (what it lists is drawn as it is read from the store).
  await expect(async () => {
    await app.page.evaluate(() => { document.scrollingElement!.scrollTop = 120; });
    expect(await read()).toBe(120);
  }).toPass();
  await app.rail.go('runtime');
  await expect.poll(read).toBe(0);
  await app.rail.go('home');
  await expect.poll(read).toBe(120);
});
