import {expect, test} from './fixtures.ts';
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
