import {expect, test} from './fixtures.ts';

// A board's guests: someone outside the server, let in by an invitation's link one of its people passes on, who
// writes there under a name of their own, signed in or not, and is led back to it when they come back.

test('a guest come back to the app is led back to their board from Home', async ({app, another}) => {
  const ada = await another('Ada');
  await ada.inbox.claim();
  await ada.server.make('Trip', `${ada.handle}-trip`);
  await ada.server.layer.getByRole('button', {name: 'Its people, boards and repos'}).click();
  await ada.server.layer.getByRole('tab', {name: /^Boards/}).click();
  const boards = ada.server.layer.getByRole('tabpanel', {name: /^Boards/});
  await boards.getByRole('switch', {name: 'Guests can write'}).click();
  const take = boards.getByRole('button', {name: 'Take guests', exact: true});
  await expect(take).toBeVisible();
  await ada.answer(take, take);
  await boards.getByRole('button', {name: 'Invite a guest', exact: true}).click();
  const link = await boards.getByRole('button', {name: 'The invitation\'s link'}).textContent();

  // Opened by the link, signed out: the name to write as, then a post as a guest.
  await app.page.goto(link!);
  await app.server.layer.getByRole('textbox', {name: 'Your name here'}).fill('Cy');
  await app.server.layer.getByRole('button', {name: 'Write as a guest', exact: true}).click();
  await app.server.post('general', 'Hello from a guest');

  // Come back another day: Home leads to the board, from Lately (where it is read and written in as the guest) and
  // from the servers, a chip after them.
  await app.page.reload();
  await app.settled();
  await app.rail.go('home');
  await expect(app.main.getByRole('button', {name: '#general of Trip, as a guest'})).toBeVisible();
  await app.main.getByRole('button', {name: /where you write as a guest/}).click();
  const look = app.page.getByRole('dialog', {name: '#general'});
  await expect(look).toContainText('Hello from a guest');
  await look.getByRole('button', {name: 'Open in Server', exact: true}).click();
  await expect(app.server.box('general')).toHaveAttribute('placeholder', 'As Cy, a guest');
  await expect(app.server.talk('general')).toContainText('Hello from a guest');
});
