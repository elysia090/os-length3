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
  // The page is the window's height: its conversation reaches the foot, and nothing of the page scrolls away.
  expect(await bo.page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight)).toBeLessThanOrEqual(0);
  await bo.inbox.message.fill('Yes, with the tent.');
  await bo.main.getByRole('button', {name: 'Send', exact: true}).click();
  await expect(bo.inbox.message).toHaveValue('');
  await ada.comeBack();
  await expect(ada.inbox.thread(bo.handle).getByText('Yes, with the tent.', {exact: true})).toBeVisible();
});

test('word that comes while one works comes into the pane\'s foot, opens where it stands to be answered, and Inbox is a deed further', async ({signedIn: ada, another}) => {
  const bo = await another('Bo');
  await bo.inbox.claim();
  await ada.inbox.claim();
  await ada.newRepo.make('hello');
  await ada.newRepo.openInForge();

  await bo.inbox.writeTo(ada.handle, 'Review: hello reads well; louder?');
  await ada.comeBack();
  const word = ada.main.locator('.pane-word .lately-row');
  await expect(word).toContainText('Bo');
  await expect(word).toContainText('Review');
  await expect(word).toContainText('hello reads well; louder?');
  // Pressed, it opens where it stands: what was said, and a reply written right there. The page stays Forge.
  await word.click();
  const card = ada.page.getByRole('dialog', {name: /^Bo/});
  await expect(card).toContainText('hello reads well; louder?');
  await expect(card.getByRole('textbox', {name: 'Reply'})).toBeFocused();
  await ada.page.keyboard.type('Louder, yes.');
  await ada.page.keyboard.press('Control+Enter');
  await expect(card).toContainText('Louder, yes.');
  // Read as it opened, the row stays while its card is out, and goes once it is put away.
  await expect(word).toBeVisible();
  await ada.page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect(word).toHaveCount(0);
  await bo.comeBack();
  await expect(bo.inbox.thread(ada.handle).getByText('Louder, yes.', {exact: true})).toBeVisible();

  // Inbox is the card's last deed: the conversation there.
  await bo.inbox.message.fill('Good.');
  await bo.main.getByRole('button', {name: 'Send', exact: true}).click();
  await ada.comeBack();
  await ada.main.locator('.pane-word .lately-row').click();
  await ada.page.getByRole('dialog', {name: /^Bo/}).getByRole('button', {name: 'Open in Inbox'}).click();
  await expect(ada.inbox.thread(bo.handle).getByText('Good.', {exact: true})).toBeVisible();
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

test('your names open with their heading at the top, and no name is let go from here', async ({signedIn: ada}) => {
  await ada.inbox.claim();
  await ada.main.getByRole('button', {name: 'Your names', exact: true}).click();
  const names = ada.main.getByRole('group', {name: 'Your names', exact: true});
  await expect(names).toContainText(ada.handle);
  await expect(ada.main.getByRole('button', {name: 'Add a domain'})).toBeVisible();
  // Renewing and adding stay; letting a name go is not offered in Inbox.
  await expect(ada.main.getByRole('button', {name: /^Let .* go$/})).toHaveCount(0);
  // The heading sits on the box's own room (8) and its own (8), with no group's step before it.
  const box = (await names.locator('xpath=..').boundingBox())!;
  const head = (await names.getByText('Your names', {exact: true}).boundingBox())!;
  expect(head.y - box.y).toBeLessThanOrEqual(17);
});
