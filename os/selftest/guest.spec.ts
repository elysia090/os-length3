import {expect, test} from './fixtures.ts';

// A board's guests: someone outside the server, let in by an invitation's link one of its people passes on, who
// writes there under a name of their own, signed in or not, and is led back to it when they come back.

test('a guest come back to the app is led back to their board from Home', async ({app, another}) => {
  const ada = await another('Ada');
  await ada.server.make('Trip', `${ada.handle}-trip`);
  await ada.server.view.getByRole('button', {name: 'Manage members, boards, and repos'}).click();
  await ada.server.view.getByRole('tab', {name: /^Boards/}).click();
  const boards = ada.server.view.getByRole('tabpanel', {name: /^Boards/});
  await boards.getByRole('switch', {name: 'Guest posting enabled'}).click();
  const take = boards.getByRole('button', {name: 'Allow guests', exact: true});
  await expect(take).toBeVisible();
  await ada.answer(take, take);
  await boards.getByRole('button', {name: 'Invite guest', exact: true}).click();
  const link = await boards.getByRole('button', {name: 'Invite link'}).textContent();

  // Opened by the link, signed out: the name to write as, then a post as a guest.
  await app.page.goto(link!);
  await app.server.view.getByRole('textbox', {name: 'Display name'}).fill('Cy');
  await app.server.view.getByRole('button', {name: 'Post as guest', exact: true}).click();
  await app.server.post('general', 'Hello from a guest');

  // Come back another day: Home leads to the board, from Lately and from the servers, a chip after them.
  await app.page.reload();
  await app.settled();
  await app.rail.go('home');
  await expect(app.main.getByRole('button', {name: '#general (Trip) · Guest'})).toBeVisible();
  await app.main.getByRole('button', {name: /where you write as a guest/}).click();
  await expect(app.server.box('general')).toHaveAttribute('placeholder', 'As guest (Cy)');
  await expect(app.server.talk('general')).toContainText('Hello from a guest');
});
