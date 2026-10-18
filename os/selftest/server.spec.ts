import {expect, test} from './fixtures.ts';

// Server: people one knows, on the Remote. A board is a conversation and a
// TODO kept together: a post goes into its talk, an item into its TODO, and
// both are what the Remote keeps (they are there when it is opened again).

test.beforeEach(async ({signedIn: app}) => {
  // A server is made under one's own name, so the name comes first.
  await app.inbox.claim();
  await app.server.make('Trip', `${app.handle}-trip`);
});

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
