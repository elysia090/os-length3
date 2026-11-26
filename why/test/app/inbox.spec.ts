import type {Locator} from '@playwright/test';
import {expect, test} from './fixtures.ts';

// Inbox: one person writes to another by their name; the other is told on
// the rail, finds it among their requests, and what they half write back
// stays with the conversation. A name no one has is said where it was written.

test('what one person writes to another arrives in their Inbox, and the rail says so', async ({signedIn: ada, another}) => {
  const bo = await another('Bo');
  await bo.inbox.named();
  await ada.inbox.named();
  await bo.rail.go('home');

  await ada.inbox.writeTo(bo.handle, 'Question: are you coming on Saturday?');
  await expect(ada.inbox.thread(bo.handle).getByText('are you coming on Saturday?', {exact: true})).toBeVisible();

  // Bo's rail says a message is not read, without opening anything (once Bo's app has looked).
  await bo.comeBack();
  // (Inbox is Server's far side: what is unread there is said on Server's icon, its own name first.)
  await expect(bo.rail.button('server')).toHaveAccessibleName('Server · Unread messages in Inbox');
  await bo.rail.go('inbox');
  await expect(bo.main.getByRole('heading', {name: 'Requests'})).toBeVisible();
  await bo.inbox.conversation(ada.handle).click();
  const thread = bo.inbox.thread(ada.handle);
  await expect(thread.getByText('are you coming on Saturday?', {exact: true})).toBeVisible();
  await expect(thread.getByText('Question', {exact: true})).toBeVisible();
  await expect(bo.inbox.message).toHaveCount(0);
  // Opened, it is read, but nothing has been accepted.
  await expect(bo.rail.button('server')).toHaveAttribute('aria-label', 'Server');
  await expect(thread.getByRole('button', {name: 'Accept'})).toBeVisible();

  // Accepted, the two know each other: Bo's answer goes back, and Ada has it.
  // Answered at once, while the conversation is drawn again for the acceptance: what went is not left in the field.
  await thread.getByRole('button', {name: 'Accept'}).click();
  await bo.inbox.message.fill('Yes, with the tent.');
  await bo.inbox.message.press('Control+Enter');
  await expect(bo.main.getByRole('heading', {name: 'Requests'})).toBeHidden();
  await expect(thread.getByText('Yes, with the tent.', {exact: true})).toBeVisible();
  await expect(bo.inbox.message).toHaveValue('');
  // The page is the window's height: its conversation reaches the foot, and nothing of the page scrolls away.
  expect(await bo.page.evaluate(() => document.scrollingElement!.scrollHeight - innerHeight)).toBeLessThanOrEqual(0);
  await ada.comeBack();
  await expect(ada.inbox.thread(bo.handle).getByText('Yes, with the tent.', {exact: true})).toBeVisible();
});

test('word that comes while one works in Git comes up at the page\'s foot, and pressed opens its conversation in Inbox', async ({signedIn: ada, another}) => {
  const bo = await another('Bo');
  await bo.inbox.named();
  await ada.inbox.named();
  await ada.newRepo.make('hello');
  await ada.newRepo.openInForge();
  await ada.rail.go('git');

  await bo.inbox.writeTo(ada.handle, 'Review: hello reads well; louder?');
  await ada.comeBack();
  const word = ada.main.getByRole('region', {name: 'New messages'}).getByRole('button');
  await expect(word).toContainText('Bo');
  await expect(word).toContainText('Review');
  await expect(word).toContainText('hello reads well; louder?');
  // It tells, it does not hold: pressed, the conversation in Inbox, where it is answered.
  await word.click();
  const request = ada.inbox.thread(bo.handle);
  await expect(request.getByText('hello reads well; louder?', {exact: true})).toBeVisible();
  await expect(ada.inbox.message).toHaveCount(0);
  await request.getByRole('button', {name: 'Accept', exact: true}).click();
  await ada.inbox.message.fill('Louder, yes.');
  await ada.main.getByRole('button', {name: 'Send', exact: true}).click();
  await bo.comeBack();
  await expect(bo.inbox.thread(ada.handle).getByText('Louder, yes.', {exact: true})).toBeVisible();
});

test('a message half written stays with its conversation', async ({signedIn: ada, another}) => {
  const bo = await another('Bo');
  await bo.inbox.named();
  await ada.inbox.named();
  await ada.inbox.writeTo(bo.handle, 'Hello');

  await ada.inbox.message.fill('Bring the');
  await ada.rail.go('home');
  await ada.rail.go('inbox');
  // Come back to, Inbox is at the conversation it was left at.
  await expect(ada.inbox.thread(bo.handle)).toBeVisible();
  await expect(ada.inbox.message).toHaveValue('Bring the');
});

test('a name no one has is said under the field, and nothing is opened', async ({signedIn: ada}) => {
  await ada.inbox.named();
  await ada.inbox.newMessage.click();
  const to = ada.inbox.recipient.getByRole('textbox', {name: 'Recipient address'});
  await to.fill('no-one-here');
  await to.press('Enter');
  await expect(ada.inbox.recipient.getByRole('alert')).toHaveText(/^Cannot deliver to no-one-here \(/);
  await expect(to).toBeFocused();
  await expect(ada.inbox.message).toHaveCount(0);
});

test('your names open with their heading at the top, and no name is let go from here', async ({signedIn: ada}) => {
  await ada.inbox.named();
  await ada.inbox.names();
  const names = ada.main.getByRole('group', {name: 'Your usernames', exact: true});
  await expect(names).toContainText(ada.handle);
  await expect(ada.main.getByRole('button', {name: 'Add domain'})).toBeVisible();
  // Adding one stays; letting a name go is not offered in Inbox.
  await expect(ada.main.getByRole('button', {name: /^Let .* go$/})).toHaveCount(0);
  // The heading is the menu's first line, a cell of paper over it (DESIGN §3, whole cells), with no group's step before it.
  const box = (await names.locator('xpath=..').boundingBox())!;
  const head = (await names.getByText('Your usernames', {exact: true}).boundingBox())!;
  expect(head.y - box.y).toBeLessThanOrEqual(24);
});

test('the conversation index, opened-paper marks and Places are independent', async ({signedIn: ada, another}) => {
  test.setTimeout(120_000);
  const mina = await another('Mina Ellis'), avery = await another('Avery Chen'), jo = await another('Jo Park');
  await ada.inbox.named();
  await mina.inbox.named();
  await avery.inbox.named();
  await jo.inbox.named();
  await ada.inbox.writeTo(mina.handle, "Can you check what happens when writing to stdout fails?");
  await mina.comeBack();
  await mina.inbox.conversation(ada.handle).click();
  await mina.inbox.thread(ada.handle).getByRole('button', {name: 'Accept', exact: true}).click();
  await mina.inbox.message.fill("I've sent the stdout fix. Could you check the error path?");
  await mina.inbox.message.press('Control+Enter');
  await avery.inbox.writeTo(ada.handle, "Would you join the Docs Club?");
  await jo.inbox.writeTo(ada.handle, "The Linux check passed.");
  await ada.comeBack();

  const {inbox, page} = ada;
  await page.setViewportSize({width: 1320, height: 792});
  const headings = inbox.conversations.getByRole('heading');
  await expect(headings).toHaveText(['Messages', 'Requests']);
  // The unread/contact poll can replace the row set between locating the headings and measuring them.
  await expect.poll(() => headings.evaluateAll((head) => head.map((h) => [h.getBoundingClientRect().x, getComputedStyle(h).fontWeight, getComputedStyle(h).fontSize])))
    .toEqual([[48, '700', '14px'], [48, '700', '14px']]);
  await expect(inbox.newMessage).toBeVisible();
  await expect(inbox.conversations.getByText('New message →')).toHaveCount(0);
  await expect(inbox.papers).toBeHidden();
  const requestRow = inbox.conversation(avery.handle);
  await expect(requestRow).toHaveAccessibleName(/unread$/);
  await expect(requestRow).toHaveAttribute('aria-current', 'false');
  await expect(requestRow.locator('.inbox-dot')).toBeVisible();
  await expect(inbox.thread(mina.handle)).toHaveCSS('background-color', 'rgb(239, 235, 227)');
  const grain = (paper: Locator) => paper.evaluate((el) => {
    const material = getComputedStyle(el);
    return [material.backgroundImage, material.backgroundSize];
  });
  await expect.poll(() => grain(inbox.thread(mina.handle))).toEqual([
    expect.stringMatching(/^conic-gradient\(rgb\(227, 222, 213\)/), '4px 4px',
  ]);
  await expect(inbox.thread(mina.handle)).toHaveCSS('box-shadow', 'rgb(26, 29, 23) 6px 6px 0px 0px');
  expect(await inbox.thread(mina.handle).boundingBox()).toEqual({x: 312, y: 96, width: 816, height: 552});
  await inbox.message.fill("I'll test the error path.");

  await requestRow.click();
  await expect(inbox.thread(avery.handle).getByRole('button', {name: 'Accept', exact: true})).toBeVisible();
  expect(await grain(inbox.thread(avery.handle))).toEqual(['none', 'auto']);
  await expect(requestRow).toHaveAttribute('aria-current', 'true');
  await expect(requestRow.locator('.inbox-dot')).toBeHidden();
  await expect(requestRow.locator('.inbox-first-line')).toHaveCSS('background-color', 'rgb(23, 22, 21)');
  await expect(requestRow.locator('.inbox-last')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(inbox.message).toHaveCount(0);
  const all = inbox.papers.getByRole('button');
  await expect(all).toHaveCount(2);
  await expect(inbox.papers.getByRole('button', {name: /Jo Park/})).toHaveCount(0);
  expect(await all.evaluateAll((marks) => marks.map((m) => [m.getBoundingClientRect().width, m.getBoundingClientRect().height]))).toEqual([[68, 24], [68, 24]]);
  await expect(all.nth(1)).toHaveAttribute('aria-current', 'true');
  await all.nth(1).focus();
  await page.keyboard.press('ArrowRight');
  await expect(all.nth(0)).toBeFocused();
  await expect(all.nth(1)).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Enter');
  await expect(inbox.message).toHaveValue("I'll test the error path.");
  await expect(all.nth(0)).toHaveAttribute('aria-current', 'true');

  await inbox.newMessage.click();
  const to = inbox.recipient.getByRole('textbox', {name: 'Recipient address'});
  await expect(to).toBeFocused();
  expect(await grain(inbox.recipient)).toEqual(['none', 'auto']);
  await to.fill('sel');
  await expect(all).toHaveCount(3);
  await all.nth(0).click();
  await expect(inbox.message).toHaveValue("I'll test the error path.");
  await all.nth(2).click();
  await expect(to).toHaveValue('sel');

  const {places, placesKey} = ada.forge;
  await placesKey.click();
  await expect(places.getByRole('menuitemradio', {name: 'Inbox', exact: true})).toBeChecked();
  await expect(places.getByRole('menuitemradio')).toHaveText(['Server', 'Inbox']);
  await page.keyboard.press('Escape');
  await expect(places).toBeHidden();
  await expect(placesKey).toBeFocused();
  await placesKey.click();
  await places.getByRole('menuitemradio', {name: 'Server', exact: true}).click();
  await expect(page.locator('#page')).toHaveAttribute('data-place', 'server');
  await ada.rail.go('inbox');
  await expect(to).toHaveValue('sel');
  await to.press('Escape');
  await expect(inbox.newMessage).toBeFocused();
  await expect(inbox.message).toHaveValue("I'll test the error path.");
  await expect(all).toHaveCount(2);
  await inbox.newMessage.click();
  await expect(to).toHaveValue('sel');
  await page.getByRole('button', {name: '← Back', exact: true}).click();
  await expect(inbox.recipient).toHaveCount(0);

  await page.setViewportSize({width: 390, height: 844});
  await expect(inbox.thread(mina.handle)).toBeInViewport({ratio: 1});
  await inbox.thread(mina.handle).getByRole('button', {name: 'Inbox', exact: true}).click();
  await expect(requestRow).toBeVisible();
  await expect(page.locator('#page')).toHaveAttribute('data-place', 'inbox');
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
});

test('opening a request from one sender does not join either offered server; explicit acceptance can join both', async ({signedIn: ada, another}) => {
  const bo = await another('Bo');
  await bo.inbox.named();
  await ada.inbox.named();
  // Real local Remotes and sessions, not browser overrides. Both invitations use the existing authenticated endpoints.
  const request = bo.page.request, origin = new URL(bo.page.url()).origin;
  const post = (path: string, data: object) => request.post(path, {data, headers: {Origin: origin}});
  for (const name of ['Docs Club', 'Coffee Break']) {
    const made = await post('/v1/servers', {name, address: bo.handle + '-' + name.toLowerCase().replaceAll(' ', '-')});
    expect(made.ok(), await made.text()).toBe(true);
    const {id} = await made.json() as {id: string};
    const offered = await post('/v1/inbox/messages', {to: ada.handle, body: `Invitation to ${name}.`, target: {server: id}});
    expect(offered.ok(), await offered.text()).toBe(true);
  }
  const admitted = async () => {
    const response = await ada.page.request.get('/v1/servers');
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json() as {name: string}[]).map((x) => x.name).sort();
  };
  await ada.comeBack();
  expect(await admitted()).toEqual([]);
  await ada.inbox.conversation(bo.handle).click();
  const thread = ada.inbox.thread(bo.handle);
  await expect(thread.getByText('Invitation to Docs Club.')).toBeVisible();
  await expect(thread.getByText('Invitation to Coffee Break.')).toBeVisible();
  await expect(thread.getByText('Accept to start a conversation. This also joins any eligible server invitations from this sender.')).toBeVisible();
  await expect(ada.inbox.message).toHaveCount(0);
  expect(await admitted()).toEqual([]);
  await thread.getByRole('button', {name: 'Accept', exact: true}).click();
  await expect(ada.inbox.message).toBeVisible();
  expect(await admitted()).toEqual(['Coffee Break', 'Docs Club']);
});
