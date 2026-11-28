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

test('Home keeps the note beside a three-line repo scrollport and a separate New repo key', async ({app}) => {
  for (const name of ['notes', 'trip', 'site', 'walk', 'workbench', 'journal']) await app.newRepo.make(name);
  await app.rail.go('home');
  const {page, main} = app;
  const repos = main.getByRole('region', {name: 'Repos'});
  const list = repos.locator('.home-repos');
  const entries = list.locator('.card.repo');
  const create = repos.getByRole('button', {name: 'New repo', exact: true});
  await expect(entries).toHaveCount(6);
  await expect(list.getByRole('button', {name: 'New repo', exact: true})).toHaveCount(0);
  const box = async (l: Locator) => (await l.boundingBox())!;
  for (const size of [{width: 1536, height: 864}, {width: 768, height: 730}, {width: 390, height: 844}]) {
    await page.setViewportSize(size);
    await expect(async () => {
      const note = await box(app.home.todo);
      const panel = await box(repos);
      expect(note.x).toBe(size.width === 390 ? 24 : 48);
      expect(note.width).toBe(size.width === 390 ? 336 : 624);
      expect(note.height).toBeGreaterThanOrEqual(288);
      if (size.width === 1536) expect(panel.x).toBeGreaterThan(note.x + note.width);
      else expect(panel.y).toBeGreaterThanOrEqual(note.y + note.height);
      const bounds = await box(list);
      expect(bounds.height).toBe(72);
      expect(bounds.x - panel.x).toBe(72);
      const first = await box(entries.first());
      for (const [i, entry] of (await entries.all()).entries()) {
        const at = await box(entry);
        expect(at.x).toBe(first.x);
        expect(Math.round(at.y - first.y)).toBe(i * 24);
      }
      expect((await box(create)).y).toBeGreaterThanOrEqual(bounds.y + bounds.height + 7);
      expect(await page.evaluate(() => {
        const doc = document.documentElement;
        return doc.scrollWidth - doc.clientWidth;
      })).toBe(0);
    }).toPass({timeout: 8_000});
  }
  await expect(app.home.todo).toHaveCSS('background-color', 'rgb(215, 197, 90)');
  await expect(app.home.todo).toHaveCSS('box-shadow', /4px 4px 0px 0px$/);
  await page.setViewportSize({width: 1536, height: 864});
  const first = entries.first().locator('.card-open');
  const last = entries.last();
  const lastName = (await last.locator('.card-title').textContent())!;
  const direct = last.getByRole('button', {name: lastName, exact: true});
  const scrollTop = () => list.evaluate(el => el.scrollTop);
  const before = await box(create);
  await list.hover();
  await page.mouse.wheel(0, 200);
  await expect.poll(scrollTop).toBeGreaterThan(0);
  await first.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowDown');
  await expect(direct).toBeFocused();
  await expect.poll(scrollTop).toBeGreaterThan(0);
  expect(await box(create)).toEqual(before);

  // An action on the last row must be outside the scrollport's clip, including its confirmation fields.
  const gear = last.getByRole('button', {name: `Actions for ${lastName}`, exact: true});
  await gear.press('Enter');
  const menu = last.getByRole('menu', {name: `Actions for ${lastName}`, exact: true});
  const rename = menu.getByRole('menuitem', {name:'Rename', exact:true});
  await expect(rename).toBeInViewport();
  await rename.click();
  const input = menu.getByRole('textbox', {name: 'New name', exact: true});
  await expect(input).toHaveValue(lastName);
  // An inner ask's Escape cancels that ask first; the next Escape dismisses the menu.
  await input.press('Escape');
  await expect(rename).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(gear).toBeFocused();
  await direct.click();
  await expect(main.getByRole('region', {name: `Files in ${lastName}`, exact: true})).toBeVisible();

  await app.rail.go('home');
  await create.press('Enter');
  await expect(main).toHaveAttribute('data-place', 'new-repo');
});

test('the narrow Home name wraps at words before splitting an unbroken name', async ({signedIn: app}) => {
  await app.rail.go('home');
  const name = app.main.locator('#profile-name');
  const write = async (text: string) => {
    await name.click();
    await name.fill(text);
    await name.press('Enter');
    await expect(name).toHaveText(text);
  };
  const lines = () => name.evaluate((el) => {
    const text = el.firstChild as Text;
    let start = 0;
    return text.data.split(' ').map((word) => {
      const range = document.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + word.length);
      start += word.length + 1;
      return [...range.getClientRects()].map((line) => ({top: line.top, right: line.right}));
    });
  });
  await write('Alexandra Longwind');
  for (const width of [320, 390]) {
    await app.page.setViewportSize({width, height: 844});
    const [first, last] = await lines();
    expect(first).toHaveLength(1);
    expect(last).toHaveLength(1);
    expect(last![0]!.top).toBeGreaterThan(first![0]!.top);
    expect(await app.page.evaluate(() => document.scrollingElement!.scrollWidth)).toBe(width);
  }

  await app.page.setViewportSize({width: 320, height: 640});
  for (const text of ['Ada Gray', '田村 蓮']) {
    await write(text);
    const rows = (await lines()).flat();
    expect(new Set(rows.map((row) => row.top)).size).toBe(1);
    expect(rows.every((row) => row.right <= 320)).toBe(true);
  }

  // If a single word really exceeds the measure, a forced line still fits the paper.
  await write('BartholomewThistlethwaiteTheSecond');
  const word = (await lines())[0]!;
  expect(word.length).toBeGreaterThan(1);
  expect(word.every((row) => row.right <= 320)).toBe(true);
  expect(await app.page.evaluate(() => document.scrollingElement!.scrollWidth)).toBe(320);
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

  test('Home opens repo Search, marks only the matching word in Forge, and Back resumes the chosen result', async ({app}) => {
    const {page, forge} = app;
    await app.rail.go('home');
    await expect(app.main.getByRole('searchbox')).toHaveCount(0);
    const lens = app.main.getByRole('button', {name: 'Search', exact: true});
    await lens.focus();
    await page.keyboard.press('Control+k');
    const screen = page.getByRole('dialog', {name: 'Search', exact: true});
    const query = screen.getByRole('searchbox');
    const scope = screen.getByRole('combobox', {name: 'Search in'});
    await expect(query).toBeFocused();
    await expect(scope).toHaveValue('hello');
    await query.fill('puts');
    const match = screen.getByRole('button', {name: /src\/main\.c.*puts\("hello"\);/});
    await expect(match.locator('mark')).toHaveText('puts');
    await match.click();

    const path = 'src/main.c', editor = forge.editor(path), paper = forge.piece(path);
    const word = paper.locator('mark.desk-match');
    await expect(screen).toHaveCount(0);
    await expect(paper).toHaveClass(/\bheld\b/);
    await expect(editor).toBeFocused();
    await expect(word).toHaveCount(1);
    await expect(word).toBeInViewport({ratio: 1});
    await expect(word).toHaveText('puts');
    await expect(word).toHaveCSS('background-image', /rgb\(236, 202, 95\)/);
    await expect(paper.locator('.desk-mark')).toHaveCount(0);
    expect(await forge.selected(path)).toBe('');
    const line = Number(await word.getAttribute('data-line'));
    expect((await editor.inputValue()).split('\n')[line - 1]).toBe('    puts("hello");');

    await page.goBack();
    await expect(query).toHaveValue('puts');
    await expect(scope).toHaveValue('hello');
    await expect(match).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(screen).toHaveCount(0);
    await expect(app.main).toHaveAttribute('data-place', 'home');
    const parkedLens = app.main.locator('.forge-layout[hidden] .forge-search-key');
    await expect(parkedLens).toHaveCount(1);
    await expect(parkedLens).toBeHidden();
    await expect(lens).toBeVisible();
    await expect(lens).toBeFocused();
  });
});

test('Home has no band or rail; its single title key offers six Places and opens File and Remote from Tools', async ({app}) => {
  await app.newRepo.make('notes');
  await app.rail.go('home');
  const {page, main} = app;
  const key = main.getByRole('button', {name: 'Home', exact: true});
  const menu = main.getByRole('menu', {name: 'Places', exact: true});
  const tools = main.getByRole('menu', {name: 'Tools', exact: true});
  await expect(page.getByRole('navigation', {name: 'Purposes', includeHidden: true})).toBeHidden();
  await expect(page.locator('#door')).toBeHidden();
  await expect(main.locator('.home-band')).toHaveCount(0);
  await expect(main.locator('.forge-places-key:visible')).toHaveCount(1);
  const shared = await key.getAttribute('aria-controls');
  await key.press('Enter');
  await expect(menu).toHaveAttribute('id', shared!);
  await expect(menu.getByRole('menuitemradio')).toHaveText(['Home', 'Forge', 'Git', 'Server', 'Inbox', 'Runtime']);
  await expect(menu.getByRole('menuitemradio', {name: 'Home', exact: true})).toBeFocused();
  await expect(menu.getByRole('menuitem')).toHaveCount(0);
  await page.keyboard.press('Escape');

  const file = tools.getByRole('menuitem', {name: 'File', exact: true});
  const remote = tools.getByRole('menuitem', {name: 'Remote', exact: true});
  await key.press('Shift+F10');
  await expect(tools).toHaveAttribute('id', shared!);
  await expect(tools.getByRole('menuitemradio')).toHaveCount(0);
  await expect(remote).toBeFocused();
  await file.click();
  await expect(tools).toBeHidden();
  await expect(main).toHaveAttribute('data-place', 'home');
  await expect(app.file.tree).toBeVisible();
  await expect(app.file.name('notes')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(app.file.tree).toBeHidden();
  await expect(key).toBeFocused();

  await key.click({button:'right'});
  await expect(tools).toHaveAttribute('id', shared!);
  await remote.click();
  await expect(main).toHaveAttribute('data-place', 'remote');
  await page.goBack();
  await expect(main).toHaveAttribute('data-place', 'home');
  await expect(menu).toBeHidden();
  await expect(app.file.tree).toBeHidden();
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

test('Home is a shot: its title keeps its size at any length, over lines on the grid with the eyeline at its first; the note, its subject, has its edge whole', async ({signedIn: app}) => {
  for (const name of ['trip', 'garden']) await app.newRepo.make(name);
  await app.rail.go('home');
  for (const line of ['Fix: The tent leaks', 'Idea: Lighter pans']) {
    const item = app.home.items.nth((await app.home.items.count()) - 1);
    await app.home.title(item).focus();
    await app.home.title(item).pressSequentially(line);
    await app.home.title(item).press('Enter');
    await app.page.keyboard.press('Escape');
  }
  const {page} = app;
  const title = page.locator('#profile-name');
  for (const size of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
    await page.setViewportSize(size);
    await title.fill('Ada');
    await title.press('Enter');
    const short = await title.evaluate((el) => getComputedStyle(el).fontSize);
    await title.fill('Augusta Ada King Lovelace');
    await title.press('Enter');
    await expect(title).toHaveText('Augusta Ada King Lovelace');
    const layout = await title.evaluate((el) => {
      const style = getComputedStyle(el), text = document.createRange();
      text.selectNodeContents(el);
      const bounds = el.getBoundingClientRect();
      const lines = [...text.getClientRects()];
      return {size: style.fontSize, lines: new Set(lines.map((r) => Math.round(r.top))).size,
        fits: lines.every((r) => r.left >= bounds.left - 1 && r.right <= bounds.right + 1)};
    });
    expect(layout.size).toBe(short);
    expect(parseFloat(layout.size)).toBeCloseTo(24 * (size.width === 390 ? 2.25 : 3) / .727, 1);
    expect(layout.lines).toBeGreaterThan(1);
    expect(layout.fits).toBe(true);
  }
  await page.setViewportSize({width: 1440, height: 900});
  // The subject's edge is whole: nothing on the note stands over its edge (an item's × inside it).
  const note = (await app.home.todo.boundingBox())!;
  for (const away of await app.home.todo.getByRole('button', {name: /^Delete /}).all()) {
    const b = (await away.boundingBox())!;
    expect(b.x + b.width, 'an item\'s × inside the note\'s edge').toBeLessThanOrEqual(note.x + note.width - 1);
  }
});
