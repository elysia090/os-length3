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

test('someone added by name is asked in their Inbox, and is in the server once they accept', async ({signedIn: ada, another}) => {
  const bo = await addBo(ada, another);

  await bo.server.openLayer();
  await expect(bo.server.chip('Trip')).toBeVisible();
  await expect(bo.server.side).toContainText(ada.handle);
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

  // A talk longer than its box: at its foot the box is closed; scrolled up, it is open at its foot.
  await app.server.layer.getByRole('button', {name: 'Previous board'}).click();
  for (let i = 1; i <= 12; i++) await app.server.post('general', `Post ${i}`);
  const card = app.server.layer.locator('.slide[aria-current="true"] .board-card');
  const bottom = () => card.evaluate((el) => getComputedStyle(el).borderBottomColor);
  await expect(talk).toContainText('Post 12');
  await expect.poll(bottom).not.toBe('rgba(0, 0, 0, 0)');
  await talk.evaluate((el) => { el.scrollTop = 0; });
  await expect.poll(bottom).toBe('rgba(0, 0, 0, 0)');
  await talk.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect.poll(bottom).not.toBe('rgba(0, 0, 0, 0)');
});
