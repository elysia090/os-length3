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

test('Home keeps a TODO creation day with its detail, leaving the title line to the task', async ({app}) => {
  await app.rail.go('home');
  const item = app.home.items.first(), title = app.home.title(item), detail = app.home.detail(item);
  await title.pressSequentially('Review: Compare the Home layout');
  await expect(item.locator('.todo-head .todo-meta')).toHaveCount(0);
  const created = item.locator('.todo-created');
  await expect(created).toHaveText(/^Created /);
  await expect(created).toBeHidden();
  await title.press('Enter');
  await expect(detail).toBeFocused();
  await expect(created).toBeVisible();
  await detail.press('Backspace');
  await expect(title).toBeFocused();
  await expect(created).toBeHidden();
  await expect(title).toHaveValue('Compare the Home layout');
  await title.press('Enter');
  await detail.fill('Keep the task first');
  await app.main.getByRole('heading', {level: 1}).click();
  await expect(created).toBeVisible();
  // Date is display metadata, never written into the task or its detail, including after restoring Home.
  await app.rail.go('runtime');
  await app.rail.go('home');
  await expect(app.home.detail(app.home.items.first())).toHaveValue('Keep the task first');
  await expect(app.home.items.first().locator('.todo-created')).toBeVisible();
  await expect(app.home.items.last().locator('.todo-created')).toBeEmpty();
  await app.me.language('English', '日本語');
  await expect(app.home.items.first().locator('.todo-created')).toHaveText(/に作成$/);
  await expect(app.home.items.first().locator('.todo-head .todo-meta')).toHaveCount(0);
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
  // From the profile's last count, Tab goes into the line to write in, not to a mark with nothing to mark.
  await app.main.locator('.counts .count-go').last().focus();
  await app.page.keyboard.press('Tab');
  await expect(app.home.title(item)).toBeFocused();
  // Pressed, its dashed mark gives the caret Go to line; written in, it is an item, its mark whole.
  await app.main.locator('.counts .count-go').last().focus();
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
  // Measured on the note, which lies turned on the desk: where each starts across the note itself.
  const left = (l: Locator) => l.evaluate((el: HTMLElement) => {
    const note = el.closest('.section')!;
    let x = 0;
    for (let e: HTMLElement | null = el; e && e !== note; e = e.offsetParent as HTMLElement | null) x += e.offsetLeft;
    return x;
  });
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

test("Home is a row of pieces on the desk's grid: the person's own (name and note) from the desk's edge, then the repos and what waits a width and two cells along, the first repo on the line the name stands on; half a screen shows the first and the edge of the second, which pressed comes to the edge; a phone one", async ({app}) => {
  for (const name of ['notes', 'trip', 'site']) await app.newRepo.make(name);
  await app.rail.go('home');
  await app.page.setViewportSize({width: 1440, height: 900});
  const repos = app.main.getByRole('region', {name: 'Repos'});
  const names = repos.getByRole('group');
  await expect(names).toHaveCount(3);
  const at = async (l: Locator) => (await l.boundingBox())!;
  const U = 24, CAP = .727, FOOT = .1245, PIECE = 24 * U;
  /** Where a name's capitals stand: their top and their feet (the display face sets them so in a line of its size). */
  const caps = (l: Locator) => l.evaluate((el, [cap, foot]) => { const r = el.getBoundingClientRect(), size = parseFloat(getComputedStyle(el).fontSize); const feet = r.bottom - foot * size; return {top: feet - cap * size, feet, x: r.x}; }, [CAP, FOOT]);
  await expect(async () => {
    // The person's name: its capitals two cells tall, a cell under the band, from the desk's edge.
    const name = await caps(app.page.locator('#profile-name'));
    expect(Math.abs(name.top - 3 * U)).toBeLessThan(1.5);
    expect(Math.abs(name.feet - 5 * U)).toBeLessThan(1.5);
    expect(Math.abs(name.x - 2 * U)).toBeLessThan(6);
    // The note: the piece in hand, from the desk's edge, a cell under the counts, as wide as a piece; paper its own
    // yellow, its shadow half a cell right and down; whole cells tall.
    const note = await at(app.home.todo);
    expect(Math.abs(note.x - 2 * U)).toBeLessThan(1);
    expect(Math.abs(note.y - 8 * U)).toBeLessThan(1);
    expect(Math.abs(note.width - PIECE)).toBeLessThan(1);
    expect(note.height % U).toBeLessThan(1);
    expect(await app.home.todo.evaluate((el) => getComputedStyle(el).boxShadow)).toMatch(/12px 12px 0px 0px$/);
    // The repos: the second piece, a width and two cells along; said on the first cell; a name every two cells,
    // capitals a cell tall, their left edges on one line; the first on the line the person's name stands on.
    const second = 2 * U + PIECE + 2 * U;
    expect(Math.abs((await at(repos)).x - second)).toBeLessThan(1);
    expect(Math.abs((await at(repos.getByRole('heading'))).y - 2 * U)).toBeLessThan(1);
    const titles = await Promise.all((await names.all()).map((n) => caps(n.locator('.card-title'))));
    for (const [i, t] of titles.entries()) {
      expect(Math.abs(t.x - second), `name ${i}: its left edge`).toBeLessThan(6);
      expect(Math.abs(t.feet - t.top - U), `name ${i}: capitals a cell tall`).toBeLessThan(1.5);
      expect(Math.abs(t.feet - (name.feet + i * 2 * U)), `name ${i}: its feet`).toBeLessThan(1.5);
    }
    // What waits: a slip under the repos, in line on the ground (it is not the piece in hand): no fill, no shadow.
    const slip = app.main.getByRole('region', {name: 'Recent activity'});
    expect(Math.abs((await at(slip)).x - second)).toBeLessThan(1);
    expect(await slip.evaluate((el) => { const c = getComputedStyle(el); return [c.backgroundColor, c.boxShadow]; })).toEqual(['rgb(220, 217, 212)', 'none']);
  }).toPass();
  // Half a screen: the first piece whole, the second cut by the window's edge. Pressed, it comes to the desk's edge;
  // scrolled back and let go, the row rests with the first there again.
  await app.page.setViewportSize({width: 768, height: 730});
  const row = app.main.locator('.home-row');
  await expect.poll(async () => { const r = await at(app.main.locator('.home-beside')); return r.x < 768 && r.x + r.width > 768; }).toBe(true);
  await repos.getByRole('heading').click({position: {x: 10, y: 10}});
  await expect.poll(async () => Math.round((await at(repos)).x)).toBe(2 * U);
  expect(await row.evaluate((el) => el.scrollLeft)).toBe(PIECE + 2 * U);
  await row.evaluate((el) => { el.scrollLeft = 100; });
  await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBe(0);
  // A phone: a piece as wide as the window has whole cells for, and one in sight; nothing wider than the window.
  await app.page.setViewportSize({width: 390, height: 844});
  await expect(async () => {
    const note = await at(app.home.todo), r = await at(repos);
    expect(note.width).toBe(13 * U);
    expect(r.x).toBeGreaterThanOrEqual(390);
    expect(await app.page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  }).toPass();
});

test('the name written on Home is the account\'s, so what is started, committed and reviewed from here says it', async ({signedIn: app}) => {
  await app.rail.go('home');
  const name = app.page.locator('#profile-name');
  // None written yet, the name shown is the one signed in with: it is written over where it stands, with no sheet
  // round it and nothing to press to begin or to end.
  await expect(name).toHaveText(app.person);
  await name.click();
  await expect(name).toBeFocused();
  await expect(app.main.getByRole('button', {name: /Edit profile|Save|Cancel/})).toHaveCount(0);
  await name.fill('Ada Byron');
  await name.press('Enter');
  await expect(name).not.toBeFocused();
  await expect(app.main.getByRole('heading', {name: 'Ada Byron', level: 1})).toBeVisible();
  // Escape leaves it as it was.
  await name.click();
  await name.fill('Someone else');
  await name.press('Escape');
  await expect(app.main.getByRole('heading', {name: 'Ada Byron', level: 1})).toBeVisible();
  // The line about the person is written under it the same way. With none yet, the way to write one stands after
  // the name while the name has the keyboard, and nothing under the profile moves as the name is pressed.
  const bio = app.main.getByRole('textbox', {name: 'Bio', exact: true});
  await expect(bio).toBeHidden();
  const todoAt = async () => (await app.home.todo.boundingBox())!.y;
  const before = await todoAt();
  await name.click();
  expect(await todoAt()).toBe(before);
  await app.main.getByRole('button', {name: 'Short bio', exact: true}).click();
  await expect(bio).toBeFocused();
  await bio.fill('Counts in fours.');
  await bio.press('Enter');
  await expect(bio).toHaveText('Counts in fours.');
  await app.open();
  await expect(app.main.getByRole('textbox', {name: 'Bio', exact: true})).toHaveText('Counts in fours.');
  // The Remote knows the person by it now.
  await app.rail.go('remote');
  await expect(app.main.getByText('Signed in as Ada Byron')).toBeVisible();
});

test('the handle on Home is the username: the one given at sign-in, and changed there it is changed for everyone', async ({signedIn: app}) => {
  await app.rail.go('home');
  await expect(app.main.locator('.identity .handle')).toHaveText(`@${app.handle}`);
  const handle = app.main.getByRole('textbox', {name: 'Handle'});
  await expect(handle).toHaveText(app.handle);
  const next = `${app.handle.slice(0, 26)}-home`;
  await handle.click();
  await handle.fill(`@${next}`);
  await handle.press('Enter');
  await expect(app.main.locator('.identity .handle')).toHaveText(`@${next}`);
  // The Remote finds them by it now: Inbox's stub says it.
  await app.inbox.named(next);
  // One no username can be is said at the handle, and nothing is saved.
  await app.rail.go('home');
  await handle.click();
  await handle.fill('-no');
  await handle.press('Enter');
  await expect(app.main.getByRole('alert')).toHaveText('Handle must be 2–31 lowercase letters, digits, or . - _');
  await expect(handle).toBeFocused();
  // Left as it is, the line says the username that is kept, not the one that could not be.
  await app.home.todo.click();
  await expect(app.main.locator('.identity .handle')).toHaveText(`@${next}`);
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

test("Home's band: one bar from the desk's edge on the row of the rail's first place, as wide as a piece; the terminal's key and the files' two cells each, edge to edge, the search the rest; the files' key is Forge's", async ({app}) => {
  await app.newRepo.make('notes');
  await app.rail.go('home');
  const tools = app.main.getByRole('group', {name: 'Tools'});
  const term = await tools.getByRole('button', {name: 'Terminal'}).boundingBox(), files = await tools.getByRole('button', {name: 'Files: New, Rename, Delete'}).boundingBox();
  const search = await tools.getByRole('searchbox').boundingBox(), first = await app.rail.button('home').boundingBox(), bar = await tools.boundingBox();
  // The bar: from the desk's edge (two cells in), as tall as a place of the rail and on its row, twenty-four cells wide.
  expect(bar).toEqual({x: 48, y: first!.y, width: 24 * 24, height: first!.height});
  // Its keys two cells wide, edge to edge on the grid's lines; the search to the bar's end.
  for (const key of [term!, files!, search!]) {
    expect(Math.abs(key.y - first!.y)).toBeLessThan(1);
    expect(Math.abs(key.height - first!.height)).toBeLessThan(1);
  }
  expect([term!.x, term!.width, files!.x, files!.width]).toEqual([48, 48, 96, 48]);
  expect(Math.abs(search!.x - 144)).toBeLessThan(1);
  expect(Math.abs(search!.x + search!.width - (48 + 24 * 24))).toBeLessThan(1);
  // Its files button is Forge's, for the repo last worked in: there, its menu out under Forge's own (its README in
  // hand there, that file's deeds).
  await app.main.getByRole('button', {name: 'Files: New, Rename, Delete'}).click();
  const menu = app.page.getByRole('menu', {name: 'README.md', exact: true});
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', {name: 'New file'})).toBeFocused();
  const under = (await app.forge.tools.getByRole('button', {name: 'Files: New, Rename, Delete'}).boundingBox())!;
  expect((await menu.boundingBox())!.y).toBeGreaterThan(under.y + under.height - 1);
});

test('what was written on Home and was not yet the core\'s when the page went is kept at the next start', async ({app}) => {
  // Written, and the page loaded again before the core had it: the page kept it meanwhile, where it writes at once.
  await app.page.evaluate(() => localStorage.setItem('why.os.unkept.profile', JSON.stringify({name: 'Grace Hopper', handle: '', bio: 'Kept at once.'})));
  await app.open();
  await app.rail.go('home');
  await expect(app.page.locator('#profile-name')).toHaveText('Grace Hopper');
  await expect(app.main.getByRole('textbox', {name: 'Bio', exact: true})).toHaveText('Kept at once.');
  // It is the core's now, and the page holds nothing: still so at a start with nothing held.
  await expect.poll(() => app.page.evaluate(() => localStorage.getItem('why.os.unkept.profile'))).toBeNull();
  await app.open();
  await app.rail.go('home');
  await expect(app.page.locator('#profile-name')).toHaveText('Grace Hopper');
});

test('what this browser kept under the name the product had before is carried over: its repos, and what its pages noted', async ({app}) => {
  await app.newRepo.make('kept');
  // Off the app (a file of its origin that starts nothing), what is kept is put where a build named root3 kept it:
  // the core's files (IndexedDB root3-core) and the pages' notes (localStorage root3.…).
  await app.page.goto('/boot.js');
  await app.page.evaluate(async () => {
    const asked = <T,>(r: IDBRequest<T>) => new Promise<T>((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    const now = await asked(indexedDB.open('why-core'));
    const before = await new Promise<IDBDatabase>((ok, no) => {
      const r = indexedDB.open('root3-core', now.version);
      r.onupgradeneeded = () => { for (const [store, by] of [['nodes', 'path'], ['meta', null], ['data', 'path']] as const) r.result.createObjectStore(store, by ? {keyPath: by} : undefined); };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
    });
    for (const store of ['nodes', 'data', 'meta']) {
      const from = now.transaction(store).objectStore(store);
      const [keys, values] = await Promise.all([asked(from.getAllKeys()), asked(from.getAll())]);
      const tx = before.transaction(store, 'readwrite');
      keys.forEach((k, i) => (store === 'meta' ? tx.objectStore(store).put(values[i], k) : tx.objectStore(store).put(values[i])));
      await new Promise<void>((ok, no) => { tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error); });
    }
    now.close();
    before.close();
    await asked(indexedDB.deleteDatabase('why-core'));
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith('why.')) continue;
      localStorage.setItem(`root3.${k.slice('why.'.length)}`, localStorage.getItem(k)!);
      localStorage.removeItem(k);
    }
  });
  const names = () => app.page.evaluate(async () => ({
    kept: (await indexedDB.databases()).map((d) => d.name).sort(),
    before: Object.keys(localStorage).filter((k) => k.startsWith('root3.')),
    repo: localStorage.getItem('why.os.repo'),
  }));
  expect(await names()).toMatchObject({kept: ['root3-core'], repo: null});
  // The app opens on it: the repo is there, last open as it was, and nothing is left under the names before.
  await app.open();
  await expect(app.newRepo.madeIn('kept')).toBeVisible();
  await expect(app.forge.editor('README.md')).toBeVisible();
  await expect.poll(names).toEqual({kept: ['why-core'], before: [], repo: 'kept'});
});

test('Home come back to is where it was read to, and the page between starts at its top', async ({app}) => {
  await app.page.setViewportSize({width: 1280, height: 300});
  await app.rail.go('home');
  const read = () => app.page.evaluate(() => Math.round(document.scrollingElement!.scrollTop));
  // Read down to 30 px, once Home is that long (what it lists is drawn as it is read from the store).
  await expect(async () => {
    await app.page.evaluate(() => { document.scrollingElement!.scrollTop = 30; });
    expect(await read()).toBe(30);
  }).toPass();
  await app.rail.go('runtime');
  await expect.poll(read).toBe(0);
  await app.rail.go('home');
  await expect.poll(read).toBe(30);
});
