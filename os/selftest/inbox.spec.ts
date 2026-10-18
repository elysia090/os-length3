import {expect, test} from './fixtures.ts';

// Inbox: one person writes to another by their name; the other is told on
// the rail, finds it among their requests, and what they half write back
// stays with the conversation. A name no one has is said where it was written.

test('what one person writes to another arrives in their Inbox, and the rail says so', async ({signedIn: ada, another}) => {
  const bo = await another('Bo');
  await bo.inbox.claim();
  await ada.inbox.claim();
  await bo.rail.go('home');

  await ada.inbox.writeTo(bo.handle, 'Question: are you coming on Saturday?');
  await expect(ada.inbox.thread(bo.handle).getByText('are you coming on Saturday?', {exact: true})).toBeVisible();

  // Bo's rail says a message is not read, without opening anything (once Bo's app has looked).
  await bo.comeBack();
  await expect(bo.rail.button('inbox')).toHaveAccessibleName('Inbox has messages not read');
  await bo.rail.go('inbox');
  await expect(bo.main.getByRole('heading', {name: 'Requests'})).toBeVisible();
  await bo.inbox.conversation(ada.handle).click();
  const thread = bo.inbox.thread(ada.handle);
  await expect(thread.getByText('are you coming on Saturday?', {exact: true})).toBeVisible();
  await expect(thread.getByText('Question', {exact: true})).toBeVisible();
  // Opened, it is read.
  await expect(bo.rail.button('inbox')).toHaveAccessibleName('Inbox');

  // Accepted, the two know each other: Bo's answer goes back, and Ada has it.
  await thread.getByRole('button', {name: 'Accept'}).click();
  await expect(bo.main.getByRole('heading', {name: 'Requests'})).toBeHidden();
  await bo.inbox.message.fill('Yes, with the tent.');
  await bo.main.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(bo.inbox.message).toHaveValue('');
  await ada.comeBack();
  await expect(ada.inbox.thread(bo.handle).getByText('Yes, with the tent.', {exact: true})).toBeVisible();
});

test('a message half written stays with its conversation', async ({signedIn: ada, another}) => {
  const bo = await another('Bo');
  await bo.inbox.claim();
  await ada.inbox.claim();
  await ada.inbox.writeTo(bo.handle, 'Hello');

  await ada.inbox.message.fill('Bring the');
  await ada.rail.go('home');
  await ada.rail.go('inbox');
  await ada.inbox.conversation(bo.handle).click();
  await expect(ada.inbox.message).toHaveValue('Bring the');
});

test('a name no one has is said under the field, and nothing is opened', async ({signedIn: ada}) => {
  await ada.inbox.claim();
  await ada.inbox.conversations.getByRole('textbox', {name: 'Write to a name or a code'}).fill('no-one-here');
  await ada.inbox.conversations.getByRole('button', {name: 'Write', exact: true}).click();

  await expect(ada.inbox.conversations.getByRole('alert')).toHaveText(/^Cannot reach no-one-here \(/);
  await expect(ada.inbox.message).toHaveCount(0);
});
