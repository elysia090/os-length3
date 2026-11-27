import type {Locator} from '@playwright/test';
import {expect, test} from './fixtures.ts';

// Inbox: one person writes to another by their name; Places says what came,
// and what they half write back stays with the conversation.

const unreadMail = 'Unread messages in Inbox';
const hasNewsDot = (control: Locator) => control.evaluate((el) => {
  const dot = getComputedStyle(el, '::after');
  return dot.content === '""' && parseFloat(dot.width) > 0 && parseFloat(dot.height) > 0 && dot.backgroundColor === getComputedStyle(el).color;
});

test('Places opens the Inbox desk before Remote answers and keeps the same frame afterwards', async ({signedIn: app}) => {
  const {main, page} = app;
  await app.rail.go('home');
  let letIn!: () => void;
  const held = new Promise<void>((resolve) => { letIn = resolve; });
  const asked = page.waitForRequest((r) => new URL(r.url()).pathname === '/v1/inbox/me');
  await page.route('**/v1/inbox/me', async (route) => { await held; await route.continue(); });
  const key = main.getByRole('button', {name: 'Places', exact: true});
  try {
    await key.click();
    await main.getByRole('menu', {name: 'Places', exact: true}).getByRole('menuitem', {name: 'Inbox', exact: true}).click();
    await asked;
    await expect(main).toHaveAttribute('data-place', 'inbox');
    await expect(main.getByRole('heading', {level: 1, name: 'Inbox', exact: true})).toBeVisible();
    await expect(main.getByRole('status')).toHaveText('Loading…');
    await expect(page.locator('body > .rail')).toBeHidden();
    await expect(main.locator('.page-head')).toHaveCount(0);
    await expect(key).toBeVisible();
    await expect(app.inbox.newMessage).toHaveCount(0);
    const corner = await key.elementHandle();
    letIn();
    await expect(app.inbox.newMessage).toBeVisible();
    await expect(main.getByText('No messages yet', {exact: true})).toBeVisible();
    await expect(main.getByRole('status')).toHaveCount(0);
    expect(await key.evaluate((shown, first) => shown === first, corner)).toBe(true);
  } finally { letIn(); }
  await page.goBack();
  await expect(main).toHaveAttribute('data-place', 'home');
  await page.goForward();
  await expect(app.inbox.newMessage).toBeVisible();
  await app.inbox.newMessage.click();
  await expect(app.inbox.recipient.getByRole('textbox', {name: 'Recipient address'})).toBeFocused();
});

test('what one person writes arrives live on the Places key and Inbox, and reading clears both marks', async ({signedIn: ada, another}) => {
  const bo = await another('Bo');
  await bo.inbox.named();
  await ada.inbox.named();
  await bo.rail.go('home');
  const {placesKey: key, places} = bo.forge;
  await expect(key).toBeVisible();
  await expect(key).toHaveAccessibleDescription('');
  expect(await hasNewsDot(key)).toBe(false);

  await ada.inbox.writeTo(bo.handle, 'Question: are you coming on Saturday?');
  await expect(ada.inbox.thread(bo.handle).getByText('are you coming on Saturday?', {exact: true})).toBeVisible();

  // The browser coming back looks at the real Remote. No reload or opening Inbox to see the news.
  await bo.comeBack();
  await expect(key).toHaveAccessibleName('Home');
  await expect(key).toHaveAccessibleDescription(unreadMail);
  expect(await hasNewsDot(key)).toBe(true);
  await expect(places).toBeHidden();
  await key.press('Enter');
  const inbox = places.getByRole('menuitem', {name: 'Inbox', exact: true});
  await expect(inbox).toHaveAccessibleDescription(unreadMail);
  expect(await hasNewsDot(inbox)).toBe(true);
  // Here Inbox has its own row: don't mark its parent as if it contained this letter, too.
  await expect(places.getByRole('menuitem', {name: 'Server', exact: true})).toHaveAccessibleDescription('');
  await inbox.press('Enter');
  await expect(bo.main).toHaveAttribute('data-place', 'inbox');
  await expect(bo.main.getByRole('heading', {name: 'Requests'})).toBeVisible();
  await expect(key).toHaveAccessibleDescription(unreadMail);
  await bo.inbox.conversation(ada.handle).click();
  const thread = bo.inbox.thread(ada.handle);
  await expect(thread.getByText('are you coming on Saturday?', {exact: true})).toBeVisible();
  await expect(thread.getByText('Question', {exact: true})).toBeVisible();
  await expect(bo.inbox.message).toHaveCount(0);
  // Opened, it is read, but nothing has been accepted.
  await expect(key).toHaveAccessibleDescription('');
  expect(await hasNewsDot(key)).toBe(false);
  await key.press('Enter');
  const readInbox = places.getByRole('menuitemradio', {name: 'Inbox', exact: true});
  await expect(readInbox).toBeChecked();
  await expect(readInbox).toHaveAccessibleDescription('');
  expect(await hasNewsDot(readInbox)).toBe(false);
  await readInbox.press('Escape');
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
  const {placesKey: key, places} = ada.forge;
  await expect(key).toHaveAccessibleDescription(unreadMail);
  await key.press('Enter');
  // Work goes by way of Server when there is no direct Inbox entry.
  await expect(places.getByRole('menuitem', {name: 'Server', exact: true})).toHaveAccessibleDescription(unreadMail);
  await ada.page.keyboard.press('Escape');
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
  await expect(to).toHaveAccessibleDescription('Username, address, or 6-digit code');
  await expect(to).toHaveCSS('border-bottom-width', '1px');
  await expect(inbox.recipient.locator('.inbox-top')).toHaveCSS('border-bottom-width', '0px');
  expect(await grain(inbox.recipient)).toEqual([
    expect.stringMatching(/^conic-gradient\(rgb\(227, 222, 213\)/), '4px 4px',
  ]);
  await expect.poll(() => inbox.recipient.boundingBox()).toEqual({x: 312, y: 96, width: 816, height: 312});
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

for (const width of [320, 390]) test.describe(`Inbox at ${width}px`, () => {
  test.use({viewport: {width, height: width === 320 ? 640 : 844}, isMobile: true, hasTouch: true});

  test('a long recipient and the letter’s controls stay on the paper without sending', async ({signedIn: app, another}) => {
    const peer = await another('Mobile Letter Recipient');
    await peer.inbox.named();
    const {page, inbox} = app;
    let sent = 0;
    await page.route('**/v1/inbox/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      sent++; await route.abort();
    });
    await inbox.named();
    await inbox.newMessage.tap();
    const to = inbox.recipient.getByRole('textbox', {name: 'Recipient address'});
    await expect(to).toBeFocused();
    await to.fill(peer.handle);
    await inbox.recipient.getByRole('button', {name: 'Open', exact: true}).tap();
    const paper = inbox.thread(peer.handle);
    const title = paper.getByRole('heading', {name: peer.handle, exact: true});
    await expect(title).toBeVisible();
    await expect(title).toHaveAccessibleName(peer.handle);
    await expect(inbox.message).toBeFocused();
    await inbox.message.tap();
    await inbox.message.fill('An unsent draft.');
    const back = paper.getByRole('button', {name: 'Inbox', exact: true});
    const send = paper.getByRole('button', {name: 'Send', exact: true});
    await expect(back).toBeInViewport({ratio: 1});
    await expect(send).toBeInViewport({ratio: 1});
    expect(await title.evaluate((el) => {
      const paper = el.closest('.inbox-thread')!;
      const bounds = paper.getBoundingClientRect();
      const words = document.createRange();
      words.selectNodeContents(el);
      const lines = [...words.getClientRects()];
      return {
        whole: lines.every((line) => line.left >= bounds.left && line.right <= bounds.right && line.bottom <= bounds.bottom),
        wrapped: lines.length > 1, sideways: paper.scrollWidth - paper.clientWidth, pageWidth: document.scrollingElement!.scrollWidth,
      };
    })).toEqual({whole: true, wrapped: true, sideways: 0, pageWidth: width});

    await back.tap();
    await expect(inbox.conversations).toBeVisible();
    await expect(paper).toBeHidden();
    // A first letter has no index row until there is a message. The address slip's Back gives it back.
    await inbox.newMessage.tap();
    await expect(inbox.recipient).toBeVisible();
    await app.main.getByRole('button', {name: '← Back', exact: true}).tap();
    await expect(inbox.message).toHaveValue('An unsent draft.');
    expect(sent).toBe(0);
  });
});

test.describe('a full custom address on a phone', () => {
  test.use({viewport: {width: 320, height: 640}, isMobile: true, hasTouch: true});

  test('the exact address can be read without pushing the writer out of the paper', async ({signedIn: app}) => {
    const {page, inbox} = app;
    // Substitute nothing but the Remote's answer for a near-limit verified domain. There is no real lookup or send.
    const address = 'reader-to-follow-up-with-people@' + ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(55), 'test'].join('.');
    await page.route((url) => url.pathname === '/v1/inbox/lookup' && url.searchParams.get('address') === address,
      (route) => route.fulfill({json: {address, reachable: true}}));
    await page.route((url) => decodeURIComponent(url.pathname) === `/v1/inbox/threads/${address}`,
      (route) => route.fulfill({json: {address, state: 'request', mutual: false, messages: []}}));
    await inbox.named();
    await inbox.newMessage.tap();
    await inbox.recipient.getByRole('textbox', {name: 'Recipient address'}).fill(address);
    await inbox.recipient.getByRole('button', {name: 'Open', exact: true}).tap();
    const paper = inbox.thread(address);
    await expect(paper.getByRole('heading', {name: address, exact: true})).toBeVisible();
    await expect(inbox.message).toBeInViewport({ratio: 1});
    await expect(paper.getByRole('button', {name: 'Inbox', exact: true})).toBeInViewport({ratio: 1});
    const head = paper.locator('.inbox-top');
    expect(await head.evaluate((el) => {
      const full = document.createRange();
      full.selectNodeContents(el.querySelector('h2')!);
      const below = full.getBoundingClientRect().bottom > el.getBoundingClientRect().bottom;
      el.scrollTop = el.scrollHeight;
      return below && el.scrollTop > 0 && full.getBoundingClientRect().bottom <= el.getBoundingClientRect().bottom;
    })).toBe(true);
    await expect(inbox.message).toBeInViewport({ratio: 1});
    await inbox.message.tap();
    await inbox.message.fill('First line\nSecond line');
    await expect(inbox.message).toHaveCSS('height', '48px');
    await expect(paper.getByRole('button', {name: 'Send', exact: true})).toBeInViewport({ratio: 1});
  });
});

test('a first letter waits for the actual thread, then uses the ordinary writing line without sending', async ({signedIn: ada, another}) => {
  const bo = await another('Bo');
  const me = await bo.page.request.get('/v1/inbox/me');
  expect(me.ok()).toBe(true);
  const {code, addresses: [{address}]} = await me.json() as {code: string; addresses: [{address: string}]};
  expect(code).toMatch(/^\d{6}$/);
  const {page, inbox} = ada;
  const writes: string[] = [];
  await page.route(/\/v1\/inbox\/(messages|contacts)$/, async (route) => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    writes.push(request.url());
    await route.abort();
  });

  let asked = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route((url) => decodeURIComponent(url.pathname) === `/v1/inbox/threads/${address}`, async (route) => {
    asked++;
    await held;
    await route.continue();
  });

  await inbox.named();
  await inbox.newMessage.click();
  const to = inbox.recipient.getByRole('textbox', {name: 'Recipient address'});
  await expect(to).toBeFocused();
  await to.fill(code);
  try {
    await to.press('Enter');
    await expect.poll(() => asked).toBe(1);
    await expect(inbox.recipient.getByRole('button', {name: 'Opening', exact: true})).toBeDisabled();
    await expect(to).toHaveValue(code);
    await expect(inbox.message).toHaveCount(0);
  } finally { release(); }

  const letter = inbox.thread(bo.handle);
  await expect(inbox.message).toBeFocused();
  await expect(inbox.message).toHaveAttribute('placeholder', `Write to ${bo.handle}`);
  await expect(letter.locator('.inbox-top')).toHaveCSS('border-bottom', '1px solid rgb(169, 164, 155)');
  const write = letter.locator('.inbox-write');
  await expect(write).toHaveCSS('border-top', '1px solid rgb(169, 164, 155)');
  await expect(letter).toHaveCSS('background-size', '4px 4px');
  const send = letter.getByRole('button', {name: 'Send', exact: true});
  await expect(send).toBeHidden();
  await inbox.message.fill('We can try it tomorrow.');
  await expect(send).toBeEnabled();
  const [rule, input, action] = await Promise.all([write.boundingBox(), inbox.message.boundingBox(), send.boundingBox()]);
  expect(rule!.x).toBe(input!.x);
  expect(rule!.x + rule!.width).toBe(action!.x + action!.width);
  expect(action!.y).toBe(input!.y);
  await expect(inbox.conversations.getByRole('button', {name: bo.handle})).toHaveCount(0);
  expect(asked).toBe(1);
  expect(writes).toEqual([]);
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
