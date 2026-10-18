import {expect, test} from './fixtures.ts';

// Inbox: one person writes to another by their name; the other finds it in
// their Inbox, as a request from someone they have not accepted yet.

test('what one person writes to another arrives in their Inbox', async ({signedIn: ada, another}) => {
  const bo = await another('Bo');
  await bo.inbox.claim();
  await ada.inbox.claim();

  await ada.inbox.writeTo(bo.handle, 'Question: are you coming on Saturday?');
  await expect(ada.main.getByText('are you coming on Saturday?', {exact: true})).toBeVisible();

  // Bo opens Inbox: Ada is among the requests, with what she asked.
  await bo.rail.go('home');
  await bo.rail.go('inbox');
  await expect(bo.main.getByRole('heading', {name: 'Requests'})).toBeVisible();
  await bo.inbox.conversation(ada.handle).click();
  await expect(bo.main.getByText('are you coming on Saturday?', {exact: true})).toBeVisible();
  await expect(bo.main.getByText('Question', {exact: true})).toBeVisible();
  await expect(bo.main.getByRole('button', {name: 'Accept'})).toBeVisible();
});
