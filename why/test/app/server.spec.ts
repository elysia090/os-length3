import {expect, test} from './fixtures.ts';
import type {Locator} from '@playwright/test';
import type {App} from './app.ts';

// Server: people one knows, on the Remote. A board is a conversation and a
// TODO kept together: a post goes into its talk, an item into its TODO, and
// both are what the Remote keeps (they are there when it is opened again).
// Someone is added by their name, asked in their Inbox; once they accept they
// are in it. What others post and one has not seen is marked on the rail and
// on the room name; what one half wrote stays with its board.

test.beforeEach(async ({signedIn: app}) => {
  await app.server.make('Trip', `${app.handle}-trip`);
});

/** Bo, added to Trip by its maker: asked in Bo's Inbox, in once Bo accepts. */
async function addBo(ada: App, another: (who: string) => Promise<App>): Promise<App> {
  const bo = await another('Bo');
  const said = await ada.server.addSomeone(bo.handle);
  await expect(said).toHaveText(`Invitation sent to ${bo.handle}'s Inbox. They will join upon accepting.`);

  await bo.rail.go('inbox');
  await bo.inbox.conversation(ada.handle).click();
  const thread = bo.inbox.thread(ada.handle);
  await expect(thread).toContainText('You are invited to join Trip. Accept the invite in your Inbox to join.');
  await thread.getByRole('button', {name: 'Accept'}).click();
  await expect(thread.getByRole('button', {name: 'Accept'})).toBeHidden();
  return bo;
}

test('a board made in a server takes posts in its talk', async ({signedIn: app}) => {
  await app.server.makeBoard('Packing');

  await app.server.post('Packing', 'Who brings the tent?');
  await expect(app.server.talk('Packing')).toContainText('Who brings the tent?');

  await app.server.close();
  await app.server.open();
  await expect(app.server.talk('Packing')).toContainText('Who brings the tent?');
});

test("a board's TODO keeps what its people write in it", async ({signedIn: app}) => {
  await app.server.makeBoard('Packing');

  // Its TODO, the part beside its talk on its head: chosen, the box at the foot (the talk's) goes.
  const part = app.server.view.getByRole('tab', {name: /^TODO/});
  await part.click();
  await expect(app.server.box('Packing')).toBeHidden();
  const first = app.server.todo.getByRole('listitem').first();
  await first.getByRole('textbox', {name: 'Task description'}).fill('Buy: tent pegs');
  await expect(first).toContainText('Buy：');
  // How many are left is said on its part.
  await expect(part).toHaveAccessibleName(/^TODO\s?1$/);
  await first.getByRole('button', {name: 'Mark as done'}).click();
  await expect(part).toHaveAccessibleName('TODO');

  // Remote storage used a moment after the writing stops: opened again, it is read from there.
  const kept = app.server.todo.getByRole('listitem').first();
  await expect(async () => {
    await app.server.close();
    await app.server.open();
    await expect(kept.getByRole('textbox', {name: 'Task description'})).toHaveValue('tent pegs', {timeout: 2000});
  }).toPass();
  await expect(kept.getByRole('button', {name: 'Mark as not done'})).toHaveAttribute('aria-pressed', 'true');

  // Clear completed, as on Home: the done one goes, for its people too.
  await app.server.todo.getByRole('button', {name: 'Clear completed'}).click();
  await expect(app.server.todo.getByRole('listitem')).toHaveCount(1);
  await expect(async () => {
    await app.server.close();
    await app.server.open();
    await expect(kept.getByRole('textbox', {name: 'Task description'})).toHaveValue('', {timeout: 2000});
  }).toPass();
});

test('what is half written in a board stays with it, through another board and another page', async ({signedIn: app}) => {
  await app.server.makeBoard('Packing');
  await app.server.box('Packing').fill('Bring the');

  await app.server.goBoard('general');
  await expect(app.server.box('general')).toHaveValue('');
  await app.server.close();
  await app.server.open();
  // Its boards come from the Remote, at the one it was left at.
  await expect(app.server.box('general')).toBeVisible();
  await app.server.goBoard('Packing');

  await expect(app.server.box('Packing')).toHaveValue('Bring the');
});

test('a board\'s name half written is there when Server is come back to', async ({signedIn: app}) => {
  const field = app.server.view.getByRole('textbox', {name: 'New board', exact: true});
  await app.server.newBoard();
  await field.fill('Food');
  await app.server.close();
  await app.server.open();
  await app.server.newBoard();
  await expect(field).toHaveValue('Food');
});

test('someone added by name is asked in their Inbox, and is in the server once they accept', async ({signedIn: ada, another}) => {
  // Ada leaves her window for Bo's while Bo accepts (a window of one's own is left as another is taken up).
  await ada.page.evaluate(() => dispatchEvent(new Event('blur')));
  const bo = await addBo(ada, another);

  await bo.server.open();
  await expect(bo.server.room('Trip')).toBeVisible();
  await expect(bo.server.side).toContainText(ada.handle);
  // Who asked sees them come in where they are, not only when Server is next opened: back in her window, who is in it
  // is looked at again at once (and every little while it is on screen, 15 s, app/runs.ts).
  await ada.page.evaluate(() => dispatchEvent(new Event('focus')));
  // (Who is in it is on the room's own sheet, the first of its row: back from behind the gear, with its boards.)
  await ada.server.view.getByRole('button', {name: 'Done', exact: true}).click();
  await expect(ada.server.side).toContainText(bo.handle, {timeout: 5000});
  // And behind the gear, where it was asked, People counts them.
  await ada.server.manage();
  await ada.server.view.getByRole('tab', {name: /^Members/}).click();
  await expect(ada.server.view.getByRole('tab', {name: /^Members\s?2$/})).toBeVisible();
  // Added already, the card says so rather than asking again.
  await ada.server.close();
  await ada.server.open();
  const again = await ada.server.addSomeone(bo.handle);
  await expect(again).toHaveText(`${bo.handle} is already a member`);
});

test('a post by someone else is marked on the rail and the room name until its board is seen', async ({signedIn: ada, another}) => {
  const bo = await addBo(ada, another);
  await ada.server.close();
  await bo.server.open();
  await bo.server.post('general', 'I have the tent.');
  await expect(bo.server.talk('general')).toContainText('I have the tent.');

  await ada.comeBack();
  await expect(ada.rail.button('server')).toHaveAccessibleName('New posts in server');
  await ada.server.open();
  // Its talk's foot in view, what came is seen: the marks go.
  await expect(ada.server.talk('general')).toContainText('I have the tent.');
  await expect(ada.rail.button('server')).toHaveAccessibleName('Server');
  await expect(ada.server.room('Trip')).toHaveAccessibleName('Trip');
});

test('a pointer resting on Server brings nothing out: its servers are on its own page\'s top line, a press away, the one with new posts there', async ({signedIn: ada, another}) => {
  const bo = await addBo(ada, another);
  await ada.server.close();
  await bo.server.open();
  await bo.server.post('general', 'I have the tent.');
  await ada.comeBack();
  await expect(ada.rail.button('server')).toHaveAccessibleName('New posts in server');
  // A rest on the icon, however long: nothing beside the rail, and nothing seen.
  await ada.rail.button('server').hover();
  await ada.page.waitForTimeout(700);
  await expect(ada.page.getByRole('navigation', {name: 'Servers'})).toHaveCount(0);
  await expect(ada.rail.button('server')).toHaveAccessibleName('New posts in server');
  await expect(ada.server.view).toBeHidden();
  // Pressed: the Server page, its current room on the top line and the one written in shown.
  await ada.rail.go('server');
  await expect(ada.server.room('Trip')).toHaveAttribute('aria-current', 'true');
  await expect(ada.server.talk('general')).toContainText('I have the tent.');
});

test('one just signed in makes a server at once: nothing is claimed first, their username was given at sign-in', async ({another}) => {
  const bo = await another('Bo');
  await bo.server.make('Books', `${bo.handle}-books`);
  await expect(bo.server.room('Books')).toHaveAttribute('aria-current', 'true');
  await expect(bo.server.view.getByRole('alert')).toHaveCount(0);
  await bo.inbox.named();
});

test('Escape while a server is named goes back to the one it was named from; the page stays', async ({signedIn: app}) => {
  await app.server.view.getByRole('button', {name: 'Create server'}).click();
  const name = app.server.view.getByRole('textbox', {name: 'Name', exact: true});
  await name.fill('Books');
  await app.page.keyboard.press('Escape');
  await expect(app.server.room('Trip')).toHaveAttribute('aria-current', 'true');
  await expect(app.server.box('general')).toBeFocused();
  await app.page.keyboard.press('Escape');
  await expect(app.server.view).toBeVisible();
  // What was written in its name is kept for the next time.
  await app.server.close();
  await app.server.open();
  await app.server.view.getByRole('button', {name: 'Create server'}).click();
  await expect(name).toHaveValue('Books');
});

test("many servers stay in one chooser on a phone without shifting the board", async ({signedIn: app}) => {
  for (const [i, n] of ['Books', 'Release 2.0', 'Reading group', 'Family'].entries()) {
    await app.server.view.getByRole('button', {name: 'Create server'}).click();
    await app.server.view.getByRole('textbox', {name: 'Name', exact: true}).fill(n);
    await app.server.view.getByRole('button', {name: 'Username on this Remote', exact: true}).click();
    await app.server.view.getByRole('textbox', {name: /^Username on this Remote/}).fill(`${app.handle}-s${i}`);
    await app.server.view.getByRole('button', {name: 'Create', exact: true}).click();
    await expect(app.server.room(n)).toHaveAttribute('aria-current', 'true');
  }
  await app.page.setViewportSize({width: 390, height: 844});
  const board = app.server.board('general');
  const before = await box(board), keyAt = await box(app.server.roomKey);
  await app.server.roomKey.click();
  await expect(app.server.roomChoices.getByRole('menuitemradio')).toHaveCount(5);
  await expect(app.server.roomChoices.getByRole('menuitemradio', {name: 'Family'})).toBeChecked();
  await expect(app.server.roomChoices).toBeInViewport({ratio: 1});
  expect(await box(board)).toEqual(before);
  expect(await box(app.server.roomKey)).toEqual(keyAt);
  await app.server.chooseRoom('Trip');
  await expect(app.server.roomChoices).toBeHidden();
});

test('the server triangle presses in place, opens from its own edge and returns to the same working board', async ({signedIn: app}) => {
  const {server, page} = app;
  await server.makeBoard('Packing');
  await server.box('Packing').fill('Bring the');
  const board = server.view.locator('.slide[aria-current=true]');
  const before = await box(board), key = await box(server.roomKey);
  const paper = await board.elementHandle();
  const hinge = server.roomKey.locator('.server-hinge');
  const closedPaint = await hinge.evaluate((el) => getComputedStyle(el).backgroundColor);
  const pivot = await box(hinge);
  await page.mouse.move(pivot.x + pivot.width / 2, pivot.y + pivot.height / 2);
  await page.mouse.down();
  await expect.poll(() => hinge.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(closedPaint);
  await expect(server.roomChoices).toBeHidden();
  await page.mouse.up();
  await expect(server.roomKey).toHaveAttribute('aria-expanded', 'true');
  expect(await box(server.roomKey)).toEqual(key);
  expect(await box(hinge)).toEqual(pivot);
  await expect(hinge.locator('svg')).toHaveCSS('transform', 'matrix(-1, 0, 0, -1, 0, 0)');
  expect(Math.abs((await box(server.roomChoices)).y - (pivot.y + pivot.height - 1))).toBeLessThan(1);
  const choices = await box(server.roomChoices);
  const paperEdge = await server.view.locator('.slide').evaluateAll((slides, x) =>
    slides.map((slide) => slide.getBoundingClientRect().left).find((left) => left >= x) ?? null, choices.x);
  expect(choices.x + choices.width).toBeLessThanOrEqual(paperEdge ?? before.x);
  expect(await box(board)).toEqual(before);
  expect(await paper?.evaluate((el) => el.isConnected)).toBe(true);
  const here = server.roomChoices.getByRole('menuitemradio', {name: 'Trip', exact: true});
  await expect(here).toBeChecked();
  await expect(here).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(server.roomChoices.getByRole('menuitem', {name: 'Manage…'})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(server.roomKey).toBeFocused();
  await expect(server.roomChoices).toBeHidden();
  await server.roomKey.click();
  await here.press('Enter');
  await expect(server.box('Packing')).toHaveValue('Bring the');
  expect(await box(board)).toEqual(before);
  expect(await paper?.evaluate((el) => el.isConnected)).toBe(true);
  await server.roomKey.click();
  await server.roomKey.click();
  await expect(server.roomKey).toHaveAttribute('aria-expanded', 'false');
  await server.roomKey.click();
  await server.box('Packing').click();
  await expect(server.roomChoices).toBeHidden();
  await expect(server.box('Packing')).toBeFocused();

  const v = server.view;
  await v.getByRole('button', {name: 'Create server'}).click();
  await v.getByRole('textbox', {name: 'Name', exact: true}).fill('Books');
  await v.getByRole('button', {name: 'Username on this Remote', exact: true}).click();
  await v.getByRole('textbox', {name: /^Username on this Remote/}).fill(`${app.handle}-book-room`);
  await v.getByRole('button', {name: 'Create', exact: true}).click();
  await expect(server.room('Books')).toHaveAttribute('aria-current', 'true');
  await server.chooseRoom('Trip');
  await expect(server.box('Packing')).toHaveValue('Bring the');
});

test("the owner writes the display name in place; cancel and failure do not rename the real room", async ({signedIn: app}) => {
  const {server, page} = app;
  const before = await server.room('Trip').getAttribute('data-server');
  const label = server.view.getByRole('button', {name: 'Rename Trip', exact: true});
  const nameAt = await box(label);
  const paper = await server.box('general').elementHandle();
  await server.box('general').fill('Bring the');
  await label.click();
  const name = server.view.getByRole('textbox', {name: 'Server name', exact: true});
  await expect(name).toBeFocused();
  expect((await box(name)).x).toBe(nameAt.x);
  await name.fill('Do not keep');
  await name.press('Escape');
  await expect(label).toBeFocused();
  await expect(server.room('Trip')).toHaveAttribute('data-server', before!);
  const route = '**/v1/servers/' + before;
  await page.route(route, async (request) => {
    if (request.request().method() !== 'PATCH') return request.continue();
    await request.fulfill({status: 503, json: {error: 'Name was not changed'}});
  });
  await label.press('F2');
  await name.fill('Workshop');
  await name.press('Enter');
  await expect(server.view.getByRole('alert').filter({hasText: 'Remote is currently unavailable (503)'})).toBeVisible();
  await expect(name).toBeFocused();
  await expect(name).toBeEditable();
  await page.unroute(route);
  await name.press('Enter');
  await expect(server.room('Workshop')).toHaveAttribute('data-server', before!);
  await expect(server.view.getByRole('button', {name: 'Rename Workshop', exact: true})).toBeFocused();
  expect(await paper?.evaluate((el) => el.isConnected)).toBe(true);
  await expect(server.box('general')).toHaveValue('Bring the');
  await server.manage();
  await expect(server.view.locator('.sheet-title')).toContainText(`${app.handle}-trip`);
  await server.close();
  await server.open();
  await expect(server.room('Workshop')).toHaveAttribute('data-server', before!);
});

test('a new board is named where it will stand: pressed to, its name has the keyboard; made, it stands there', async ({signedIn: app}) => {
  await app.server.newBoard();
  const name = app.server.view.getByRole('textbox', {name: 'New board', exact: true});
  await expect(name).toBeFocused();
  await app.page.keyboard.type('General');
  await app.page.keyboard.press('Enter');
  await expect(app.server.view.getByRole('alert').filter({hasText: 'A board named "General" already exists'})).toBeVisible();
  await name.fill('Packing');
  await name.press('Enter');
  await expect(app.server.box('Packing')).toBeVisible();
  // Come to by ← → instead, the keyboard stays on the row, to go on along it.
  await app.server.view.locator('.slide-stage').focus();
  await app.page.keyboard.press('ArrowRight');
  await expect(name).toBeVisible();
  await expect(name).not.toBeFocused();
});

test('Post comes with the words, the empty box saying whom it writes to whole: on a phone as on a whole screen', async ({signedIn: app}) => {
  const field = app.server.box('general');
  const post = app.server.view.getByRole('button', {name: 'Post', exact: true});
  for (const [size, words] of [[{width: 390, height: 844}, 'Who brings the tent?'], [{width: 1440, height: 900}, 'And the stove?']] as const) {
    await app.page.setViewportSize(size);
    await expect(field).toBeVisible();
    await expect(post).toBeHidden();
    await field.fill(words);
    await expect(post).toBeVisible();
    await post.click();
    await expect(app.server.talk('general')).toContainText(words);
    await expect(post).toBeHidden();
  }
});

test('Post at the box sends what is written, the keyboard staying in the box', async ({signedIn: app}) => {
  const field = app.server.box('general');
  await field.fill('Who brings the tent?');
  await app.server.view.getByRole('button', {name: 'Post', exact: true}).click();
  await expect(app.server.talk('general')).toContainText('Who brings the tent?');
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();
});

/** Behind the gear, at its part `part`. */
async function gearAt(app: App, part: string) {
  await app.server.manage();
  await app.server.view.getByRole('tab', {name: new RegExp(`^${part}`)}).click();
  return app.server.view.getByRole('tabpanel', {name: new RegExp(`^${part}`)});
}
const box = async (l: Locator) => (await l.boundingBox())!;

test("behind the gear, Done is at the sheet's bottom right, under its parts, and goes back to the boards", async ({signedIn: app}) => {
  const people = await gearAt(app, 'Members');
  const done = app.server.view.getByRole('button', {name: 'Done', exact: true});
  const [d, panel, sw] = [await box(done), await box(people), await box(app.server.view.getByRole('tablist'))];
  expect(d.y).toBeGreaterThan(panel.y + panel.height);
  expect(d.x + d.width).toBeGreaterThan(sw.x + sw.width - 1);
  // Its word starts where the people's names start, not in the middle of its card.
  const add = people.getByRole('button', {name: 'Add contact'});
  const name = people.getByText(app.handle, {exact: true}).first();
  const card = people.locator('.small-card').first();
  // Where the words themselves start in each card, from its own corner.
  // (Its words, not its mark: the last of its text.)
  const words = (l: Locator) => l.evaluate((el) => {
    const t = [...el.childNodes].reverse().find((n) => n.nodeType === Node.TEXT_NODE && n.textContent!.trim()) ?? el;
    const r = document.createRange(); r.selectNodeContents(t); const b = r.getBoundingClientRect(); return {x: b.x, y: b.y};
  });
  const [a, c, w, n] = [await box(add), await box(card), await words(add), await words(name)];
  expect(Math.abs((w.x - a.x) - (n.x - c.x))).toBeLessThan(1);
  expect(Math.abs((w.y - a.y) - (n.y - c.y))).toBeLessThan(1);
  await done.click();
  await expect(app.server.box('general')).toBeVisible();
  // On a phone it is there too.
  await app.page.setViewportSize({width: 390, height: 844});
  await gearAt(app, 'Boards');
  await expect(done).toBeInViewport();
});

test('taking guests on a board not open says first that anyone then reads it', async ({signedIn: app}) => {
  const boards = await gearAt(app, 'Boards');
  await boards.getByRole('switch', {name: 'Guest posting enabled'}).click();
  await expect(boards).toContainText('Anyone can view #general without signing in.');
  await expect(boards).toContainText('Invited users can post to #general as guests.');
});

/** Board general of `app`'s server takes guests (asked in its card, answered). */
async function takeGuests(app: App, boards: Locator) {
  await boards.getByRole('switch', {name: 'Guest posting enabled'}).click();
  // Asked once the switch has moved: answered then, not before it is there.
  await expect(boards.getByRole('button', {name: 'Allow guests', exact: true})).toBeVisible();
  await app.answer(boards.getByRole('button', {name: 'Allow guests', exact: true}), boards.getByText('Invited users can post to #general as guests.'));
  await expect(boards.getByRole('switch', {name: 'Guest posting enabled'})).toBeChecked();
}

test('guests turned off with nobody let in goes at once; with an invitation out it asks first, saying what it ends', async ({signedIn: app}) => {
  const boards = await gearAt(app, 'Boards');
  const guests = boards.getByRole('switch', {name: 'Guest posting enabled'});
  await takeGuests(app, boards);
  await guests.click();
  await expect(guests).not.toBeChecked();
  await expect(boards.getByRole('button', {name: 'Disable', exact: true})).toHaveCount(0);

  await takeGuests(app, boards);
  await boards.getByRole('button', {name: 'Invite guest', exact: true}).click();
  await expect(boards.getByRole('button', {name: 'Invite link'})).toBeVisible();
  const ends = boards.getByText('1 active invite link invalidated.');
  // No longer open to everyone ends it too, and says so.
  await boards.getByRole('switch', {name: 'Publicly visible'}).click();
  await expect(boards).toContainText('#general will be restricted to server members.');
  await expect(ends).toBeVisible();
  await boards.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(boards.getByRole('switch', {name: 'Publicly visible'})).toBeChecked();
  await guests.click();
  await expect(ends).toBeVisible();
  await expect(boards).toContainText('Re-enabling guests does not restore expired invite links.');
  await app.answer(boards.getByRole('button', {name: 'Disable', exact: true}), ends);
  await expect(guests).not.toBeChecked();
});

test('someone one knows added at once is told in their Inbox by the Remote\'s notice, which opens the server', async ({signedIn: ada, another}) => {
  const bo = await addBo(ada, another);
  await ada.server.close();
  await ada.server.open();
  await ada.server.view.getByRole('button', {name: 'Create server'}).click();
  await ada.server.view.getByRole('textbox', {name: 'Name', exact: true}).fill('Books');
  await ada.server.view.getByRole('button', {name: 'Username on this Remote', exact: true}).click();
  await ada.server.view.getByRole('textbox', {name: /^Username on this Remote/}).fill(`${ada.handle}-books`);
  await ada.server.view.getByRole('button', {name: 'Create', exact: true}).click();
  await expect(ada.server.room('Books')).toHaveAttribute('aria-current', 'true');
  // The two know each other: Bo is in at once.
  await ada.server.addSomeone(bo.handle);
  await expect(ada.server.view.getByRole('tabpanel', {name: /^Members/})).toContainText(bo.handle);

  await bo.comeBack();
  await bo.rail.go('inbox');
  await bo.inbox.conversation(ada.handle).click();
  const thread = bo.inbox.thread(ada.handle);
  // The Remote's notice, a line across the conversation in no one's voice, and the way to the server.
  const notice = thread.getByRole('button', {name: `${ada.person} added you to Books.`, exact: true});
  await expect(notice).toBeVisible();
  await notice.click();
  await expect(bo.server.room('Books')).toHaveAttribute('aria-current', 'true');
});


test('This server says what leaving and removing it come to: its maker alone a day, with others whose it becomes', async ({signedIn: ada, another}) => {
  const part = await gearAt(ada, 'This server');
  const leave = part.locator('.small-card', {hasText: 'Leave this server'});
  const remove = part.locator('.small-card', {hasText: 'Delete this server'});
  await expect(leave).toContainText('No other members remain; leaving will delete the server.');
  await expect(leave).toContainText('Can be restored within 1 day.');
  await expect(remove).toContainText('Can be restored within 1 day.');
  await expect(part).not.toContainText('whoever came next');
  await ada.server.view.getByRole('button', {name: 'Done', exact: true}).click();

  const bo = await addBo(ada, another);
  await ada.server.close();
  await ada.server.open();
  await gearAt(ada, 'This server');
  await expect(leave).toContainText(`Ownership transfers to ${bo.handle}.`);
  await expect(leave).not.toContainText('bring it back');
  await expect(remove).toContainText('Can be restored within 30 days.');
  // The ask says the same before the deed.
  await leave.getByRole('button', {name: 'Leave', exact: true}).click();
  await expect(leave).toContainText(`Leave Trip.Ownership transfers to ${bo.handle}.`);
});

test('an empty board says so at its talk\'s foot, by the box one writes in; a talk longer than its board says at its top that it is whole', async ({signedIn: app}) => {
  const talk = app.server.talk('general');
  const empty = talk.getByText('No posts yet', {exact: true});
  await expect(empty).toBeVisible();
  const [e, tk] = [await box(empty), await box(talk)];
  expect(tk.y + tk.height - (e.y + e.height)).toBeLessThan(40);

  // New board's line breaks where its sentence does.
  await app.server.newBoard();
  const about = app.server.view.getByText(/^A board groups discussions/);
  await expect(about.locator('br')).toHaveCount(1);
  await expect(about).toHaveText('A board groups discussions and shared tasks around a topic:e.g. trips, releases, or study groups.');

  // A talk longer than its board scrolls inside it, over the box one writes in at the sheet's foot.
  await app.server.goBoard('general');
  // Every post on the board at once, it is not said to be every post: that is plain to see.
  const every = talk.getByText('No more posts', {exact: true});
  for (let i = 1; i <= 2; i++) await app.server.post('general', `Post ${i}`);
  await expect(talk).toContainText('Post 2');
  await expect(every).toBeHidden();
  for (let i = 3; i <= 30; i++) await app.server.post('general', `Post ${i}`);
  await expect(talk).toContainText('Post 30');
  // The box it is written in stays at the sheet's foot, in sight, however far the talk is scrolled.
  const field = app.server.box('general');
  await talk.evaluate((el) => { el.scrollTop = 0; });
  await expect(field).toBeInViewport();
  // More than the board shows, at its top it is said.
  await expect(every).toBeVisible();
});
