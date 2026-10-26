import {expect, test} from './fixtures.ts';
import type {Locator} from '@playwright/test';
import type {App} from './app.ts';

// Server: people one knows, on the Remote. A board is a conversation and a
// TODO kept together: a post goes into its talk, an item into its TODO, and
// both are what the Remote keeps (they are there when it is opened again).
// Someone is added by their name, asked in their Inbox; once they accept they
// are in it. What others post and one has not seen is marked on the rail and
// on the server's chip; what one half wrote stays with its board.

test.beforeEach(async ({signedIn: app}) => {
  // A server is made under one's own name, so the name comes first.
  await app.inbox.claim();
  await app.server.make('Trip', `${app.handle}-trip`);
});

/** Bo, added to Trip by its maker: asked in Bo's Inbox, in once Bo accepts. */
async function addBo(ada: App, another: (who: string) => Promise<App>): Promise<App> {
  const bo = await another('Bo');
  await bo.inbox.claim();
  const said = await ada.server.addSomeone(bo.handle);
  await expect(said).toHaveText(`Asked ${bo.handle} in the Inbox. They come in once they accept you.`);

  await bo.rail.go('inbox');
  await bo.inbox.conversation(ada.handle).click();
  const thread = bo.inbox.thread(ada.handle);
  await expect(thread).toContainText('I would like to add you to Trip. Accept me in your Inbox and you are in it.');
  await thread.getByRole('button', {name: 'Accept'}).click();
  await expect(thread.getByRole('button', {name: 'Accept'})).toBeHidden();
  return bo;
}

test('a board made in a server takes posts in its talk', async ({signedIn: app}) => {
  await app.server.makeBoard('Packing');

  await app.server.post('Packing', 'Who brings the tent?');
  await expect(app.server.talk('Packing')).toContainText('Who brings the tent?');

  await app.server.close();
  await app.server.openLayer();
  await expect(app.server.talk('Packing')).toContainText('Who brings the tent?');
});

test("a board's TODO keeps what its people write in it", async ({signedIn: app}) => {
  await app.server.makeBoard('Packing');

  const first = app.server.todo.getByRole('listitem').first();
  await first.getByRole('textbox', {name: 'What to do'}).fill('Buy: tent pegs');
  await expect(first).toContainText('Buy：');
  await expect(app.server.todo).toContainText('1 of 1 left');
  await first.getByRole('button', {name: 'Mark as done'}).click();
  await expect(app.server.todo).toContainText('0 of 1 left');

  // Kept on the Remote a moment after the writing stops: opened again, it is read from there.
  const kept = app.server.todo.getByRole('listitem').first();
  await expect(async () => {
    await app.server.close();
    await app.server.openLayer();
    await expect(kept.getByRole('textbox', {name: 'What to do'})).toHaveValue('tent pegs', {timeout: 2000});
  }).toPass();
  await expect(kept.getByRole('button', {name: 'Mark as not done'})).toHaveAttribute('aria-pressed', 'true');
});

test('what is half written in a board stays with it, through another board and the layer put away', async ({signedIn: app}) => {
  await app.server.makeBoard('Packing');
  await app.server.box('Packing').fill('Bring the');

  await app.server.layer.getByRole('button', {name: 'Previous board'}).click();
  await expect(app.server.box('general')).toHaveValue('');
  await app.server.close();
  await app.server.openLayer();
  // Its boards come from the Remote, at the one it was left at (pressed before, Next board has nothing to go to).
  await expect(app.server.box('general')).toBeVisible();
  await app.server.layer.getByRole('button', {name: 'Next board'}).click();

  await expect(app.server.box('Packing')).toHaveValue('Bring the');
});

test('a board\'s name half written is there when Server is out again, put away with Escape', async ({signedIn: app}) => {
  const field = app.server.layer.getByRole('textbox', {name: 'New board', exact: true});
  const next = app.server.layer.getByRole('button', {name: 'Next board'});
  for (let i = 0; i < 20 && !(await field.isVisible()); i++) await next.click();
  await field.fill('Food');
  await app.page.keyboard.press('Escape');
  await expect(app.server.layer).toBeHidden();
  await app.server.openLayer();
  for (let i = 0; i < 20 && !(await field.isVisible()); i++) await next.click();
  await expect(field).toHaveValue('Food');
});

test('someone added by name is asked in their Inbox, and is in the server once they accept', async ({signedIn: ada, another}) => {
  const bo = await addBo(ada, another);

  await bo.server.openLayer();
  await expect(bo.server.chip('Trip')).toBeVisible();
  await expect(bo.server.side).toContainText(ada.handle);
  // Who asked sees them come in where they are, not only when Server is next opened: who is in it is looked at again
  // every little while (15 s).
  await expect(ada.server.side).toContainText(bo.handle, {timeout: 30_000});
  // And behind the gear, where it was asked, People counts them.
  await expect(ada.server.layer.getByRole('tab', {name: /^People\s?2$/})).toBeVisible({timeout: 30_000});
  // Added already, the card says so rather than asking again.
  await ada.server.close();
  await ada.server.openLayer();
  const again = await ada.server.addSomeone(bo.handle);
  await expect(again).toHaveText(`${bo.handle} is in it already`);
});

test('a post by someone else is marked on the rail and the chip until its board is seen', async ({signedIn: ada, another}) => {
  const bo = await addBo(ada, another);
  await ada.server.close();
  await bo.server.openLayer();
  await bo.server.post('general', 'I have the tent.');
  await expect(bo.server.talk('general')).toContainText('I have the tent.');

  await ada.comeBack();
  await expect(ada.rail.button('server')).toHaveAccessibleName('Server has new posts');
  await ada.server.openLayer();
  // Its talk's foot in view, what came is seen: the marks go.
  await expect(ada.server.talk('general')).toContainText('I have the tent.');
  await expect(ada.rail.button('server')).toHaveAccessibleName('Server');
  await expect(ada.server.chip('Trip')).toHaveAccessibleName('Trip');
});

test('a rest on Server too short to bring it out sees nothing: what came stays marked', async ({signedIn: ada, another}) => {
  const bo = await addBo(ada, another);
  await ada.server.close();
  await bo.server.openLayer();
  await bo.server.post('general', 'I have the tent.');
  await ada.comeBack();
  await expect(ada.rail.button('server')).toHaveAccessibleName('Server has new posts');
  // The rest makes it ready unseen (reading what it opens on); moved on before it comes out, it is let go.
  await ada.rail.button('server').hover();
  await ada.page.waitForTimeout(350);
  await ada.page.mouse.move(700, 450);
  await ada.page.waitForTimeout(1000);
  await expect(ada.server.layer).toBeHidden();
  await expect(ada.rail.button('server')).toHaveAccessibleName('Server has new posts');
});

test('making a server before one has a name says so under the band, with the way to the Inbox', async ({another}) => {
  const bo = await another('Bo');
  await bo.server.openLayer();
  await bo.server.layer.getByRole('textbox', {name: 'Name', exact: true}).fill('Books');
  await bo.server.layer.getByRole('button', {name: 'Make', exact: true}).click();
  await expect(bo.server.layer.getByRole('alert').filter({hasText: 'A server needs your name. Claim one in Inbox.'})).toBeVisible();
  // Not taken for a name someone else has: its name on this Remote is not opened to be written otherwise.
  await expect(bo.server.layer.getByRole('textbox', {name: /^Name on this Remote/})).toBeHidden();
  await bo.server.layer.getByRole('button', {name: 'Go to Inbox', exact: true}).click();
  await expect(bo.server.layer).toBeHidden();
  await expect(bo.rail.button('inbox')).toHaveAttribute('aria-current', 'page');
});

test('Escape while a server is named goes back to the one it was named from, then puts Server away', async ({signedIn: app}) => {
  await app.server.layer.getByRole('button', {name: 'Make a server'}).click();
  const name = app.server.layer.getByRole('textbox', {name: 'Name', exact: true});
  await name.fill('Books');
  await app.page.keyboard.press('Escape');
  await expect(app.server.chip('Trip')).toBeChecked();
  await expect(app.server.box('general')).toBeFocused();
  await app.page.keyboard.press('Escape');
  await expect(app.server.layer).toBeHidden();
  // What was written in its name is kept for the next time.
  await app.server.openLayer();
  await app.server.layer.getByRole('button', {name: 'Make a server'}).click();
  await expect(name).toHaveValue('Books');
});

test("many servers are one row on a phone's width, the one chosen slid into view", async ({signedIn: app}) => {
  const band = app.server.layer.getByRole('radiogroup', {name: 'Server'});
  for (const [i, n] of ['Books', 'Release 2.0', 'Reading group', 'Family'].entries()) {
    await app.server.layer.getByRole('button', {name: 'Make a server'}).click();
    await app.server.layer.getByRole('textbox', {name: 'Name', exact: true}).fill(n);
    await app.server.layer.getByRole('button', {name: 'Name on this Remote', exact: true}).click();
    await app.server.layer.getByRole('textbox', {name: /^Name on this Remote/}).fill(`${app.handle}-s${i}`);
    await app.server.layer.getByRole('button', {name: 'Make', exact: true}).click();
    await expect(app.server.chip(n)).toBeChecked();
  }
  await app.page.setViewportSize({width: 390, height: 844});
  const chip = await box(app.server.chip('Family'));
  await expect.poll(async () => (await box(band)).height).toBeLessThan(chip.height * 1.5);
  await expect.poll(async () => { const b = await box(band), c = await box(app.server.chip('Family')); return c.x >= b.x && c.x + c.width <= b.x + b.width; }).toBe(true);
});

test('a new board is named where it will stand: pressed to, its name has the keyboard; made, it stands there', async ({signedIn: app}) => {
  await app.server.layer.getByRole('button', {name: 'Next board'}).click();
  const name = app.server.layer.getByRole('textbox', {name: 'New board', exact: true});
  await expect(name).toBeFocused();
  await app.page.keyboard.type('General');
  await app.page.keyboard.press('Enter');
  await expect(app.server.layer.getByRole('alert').filter({hasText: 'There is a board named General already'})).toBeVisible();
  await name.fill('Packing');
  await name.press('Enter');
  await expect(app.server.box('Packing')).toBeVisible();
  // Come to by ← → instead, the keyboard stays on the row, to go on along it.
  await app.server.layer.locator('.slide-stage').focus();
  await app.page.keyboard.press('ArrowRight');
  await expect(name).toBeVisible();
  await expect(name).not.toBeFocused();
});

test('Post at the box sends what is written, the keyboard staying in the box', async ({signedIn: app}) => {
  const field = app.server.box('general');
  await field.fill('Who brings the tent?');
  await app.server.layer.getByRole('button', {name: 'Post', exact: true}).click();
  await expect(app.server.talk('general')).toContainText('Who brings the tent?');
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();
});

/** Behind the gear, at its part `part`. */
async function gearAt(app: App, part: string) {
  await app.server.layer.getByRole('button', {name: 'Its people, boards and repos'}).click();
  await app.server.layer.getByRole('tab', {name: new RegExp(`^${part}`)}).click();
  return app.server.layer.getByRole('tabpanel', {name: new RegExp(`^${part}`)});
}
const box = async (l: Locator) => (await l.boundingBox())!;

test("behind the gear, Done is at the sheet's bottom right, under its parts, and goes back to the boards", async ({signedIn: app}) => {
  const people = await gearAt(app, 'People');
  const done = app.server.layer.getByRole('button', {name: 'Done', exact: true});
  const [d, panel, sw] = [await box(done), await box(people), await box(app.server.layer.getByRole('tablist'))];
  expect(d.y).toBeGreaterThan(panel.y + panel.height);
  expect(d.x + d.width).toBeGreaterThan(sw.x + sw.width - 1);
  // Its word starts where the people's names start, not in the middle of its card.
  const add = people.getByRole('button', {name: 'Add someone you know'});
  const name = people.getByText(app.handle, {exact: true}).first();
  const card = people.locator('.small-card').first();
  // Where the words themselves start in each card, from its own corner.
  const words = (l: Locator) => l.evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return {x: b.x, y: b.y}; });
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
  await boards.getByRole('switch', {name: 'Guests can write'}).click();
  await expect(boards).toContainText('Anyone reads #general, signed in or not.');
  await expect(boards).toContainText('Someone its people invite writes in #general, shown as a guest.');
});

/** Board general of `app`'s server takes guests (asked in its card, answered). */
async function takeGuests(app: App, boards: Locator) {
  await boards.getByRole('switch', {name: 'Guests can write'}).click();
  // Asked once the switch has moved: answered then, not before it is there.
  await expect(boards.getByRole('button', {name: 'Take guests', exact: true})).toBeVisible();
  await app.answer(boards.getByRole('button', {name: 'Take guests', exact: true}), boards.getByText('Someone its people invite writes in #general, shown as a guest.'));
  await expect(boards.getByRole('switch', {name: 'Guests can write'})).toBeChecked();
}

test('guests turned off with nobody let in goes at once; with an invitation out it asks first, saying what it ends', async ({signedIn: app}) => {
  const boards = await gearAt(app, 'Boards');
  const guests = boards.getByRole('switch', {name: 'Guests can write'});
  await takeGuests(app, boards);
  await guests.click();
  await expect(guests).not.toBeChecked();
  await expect(boards.getByRole('button', {name: 'Turn off', exact: true})).toHaveCount(0);

  await takeGuests(app, boards);
  await boards.getByRole('button', {name: 'Invite a guest', exact: true}).click();
  await expect(boards.getByRole('button', {name: 'The invitation\'s link'})).toBeVisible();
  const ends = boards.getByText('1 invitation out lets nobody in any more.');
  // No longer open to everyone ends it too, and says so.
  await boards.getByRole('switch', {name: 'Show to everyone'}).click();
  await expect(boards).toContainText('Only its people read #general then.');
  await expect(ends).toBeVisible();
  await boards.getByRole('button', {name: 'Not now', exact: true}).click();
  await expect(boards.getByRole('switch', {name: 'Show to everyone'})).toBeChecked();
  await guests.click();
  await expect(ends).toBeVisible();
  await expect(boards).toContainText('Taking guests again, an old link lets nobody back.');
  await app.answer(boards.getByRole('button', {name: 'Turn off', exact: true}), ends);
  await expect(guests).not.toBeChecked();
});

test('someone one knows added at once is told in their Inbox, and the server\'s name there opens it', async ({signedIn: ada, another}) => {
  const bo = await addBo(ada, another);
  await ada.server.close();
  await ada.server.openLayer();
  await ada.server.layer.getByRole('button', {name: 'Make a server'}).click();
  await ada.server.layer.getByRole('textbox', {name: 'Name', exact: true}).fill('Books');
  await ada.server.layer.getByRole('button', {name: 'Name on this Remote', exact: true}).click();
  await ada.server.layer.getByRole('textbox', {name: /^Name on this Remote/}).fill(`${ada.handle}-books`);
  await ada.server.layer.getByRole('button', {name: 'Make', exact: true}).click();
  await expect(ada.server.chip('Books')).toBeChecked();
  // The two know each other: Bo is in at once.
  await ada.server.addSomeone(bo.handle);
  await expect(ada.server.layer.getByRole('tabpanel', {name: /^People/})).toContainText(bo.handle);

  await bo.comeBack();
  await bo.rail.go('inbox');
  await bo.inbox.conversation(ada.handle).click();
  const thread = bo.inbox.thread(ada.handle);
  await expect(thread).toContainText('I added you to Books.');
  await thread.getByRole('button', {name: 'Books', exact: true}).click();
  await expect(bo.server.chip('Books')).toBeChecked();
});


test('This server says what leaving and removing it come to: its maker alone a day, with others whose it becomes', async ({signedIn: ada, another}) => {
  const part = await gearAt(ada, 'This server');
  const leave = part.locator('.small-card', {hasText: 'Leave this server'});
  const remove = part.locator('.small-card', {hasText: 'Remove this server'});
  await expect(leave).toContainText('Nobody else is in it: it goes with you.');
  await expect(leave).toContainText('You can bring it back within 1 day.');
  await expect(remove).toContainText('You can bring it back within 1 day.');
  await expect(part).not.toContainText('whoever came next');
  await ada.server.layer.getByRole('button', {name: 'Done', exact: true}).click();

  const bo = await addBo(ada, another);
  await ada.server.close();
  await ada.server.openLayer();
  await gearAt(ada, 'This server');
  await expect(leave).toContainText(`${bo.handle} becomes its owner.`);
  await expect(leave).not.toContainText('bring it back');
  await expect(remove).toContainText('You can bring it back within 30 days.');
  // The ask says the same before the deed.
  await leave.getByRole('button', {name: 'Leave', exact: true}).click();
  await expect(leave).toContainText(`You leave Trip.${bo.handle} becomes its owner.`);
});

test('an empty board says so at its talk\'s foot, by the box one writes in; a board with more below opens at its foot', async ({signedIn: app}) => {
  const talk = app.server.talk('general');
  const empty = talk.getByText('No posts yet', {exact: true});
  await expect(empty).toBeVisible();
  const [e, tk] = [await box(empty), await box(talk)];
  expect(tk.y + tk.height - (e.y + e.height)).toBeLessThan(40);

  // New board's line breaks where its sentence does.
  await app.server.layer.getByRole('button', {name: 'Next board'}).click();
  const about = app.server.layer.getByText(/^A board is one thing to talk about/);
  await expect(about.locator('br')).toHaveCount(1);
  await expect(about).toHaveText('A board is one thing to talk about, with a TODO kept together:a trip, a release, a reading group.');

  // A talk longer than its board (the board's whole height is the talk's): at its foot the board is closed; scrolled
  // up, it is open at its foot.
  await app.server.layer.getByRole('button', {name: 'Previous board'}).click();
  // Every post on the board at once, it is not said to be every post: that is plain to see.
  const every = talk.getByText('That is every post', {exact: true});
  for (let i = 1; i <= 2; i++) await app.server.post('general', `Post ${i}`);
  await expect(talk).toContainText('Post 2');
  await expect(every).toBeHidden();
  for (let i = 3; i <= 30; i++) await app.server.post('general', `Post ${i}`);
  const card = app.server.layer.locator('.slide[aria-current="true"] .board-card');
  const bottom = () => card.evaluate((el) => getComputedStyle(el).borderBottomColor);
  await expect(talk).toContainText('Post 30');
  await expect.poll(bottom).not.toBe('rgba(0, 0, 0, 0)');
  await talk.evaluate((el) => { el.scrollTop = 0; });
  await expect.poll(bottom).toBe('rgba(0, 0, 0, 0)');
  // More than the board shows, at its top it is said.
  await expect(every).toBeVisible();
  await talk.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(bottom).not.toBe('rgba(0, 0, 0, 0)');
});
