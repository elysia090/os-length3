import {expect, test} from './fixtures.ts';

// The language is chosen in the person's menu; the OS then speaks it at once,
// the rail and the page alike, and keeps speaking it the next time.

test('choosing 日本語 shows the page in Japanese, and it stays chosen', async ({app}) => {
  await app.rail.go('home');
  await expect(app.main.getByRole('button', {name: 'Edit profile'})).toBeVisible();

  await app.me.language('English', '日本語');

  await expect(app.main.getByRole('button', {name: 'プロフィールを編集する'})).toBeVisible();
  await expect(app.main.getByRole('heading', {name: '名前はまだありません'})).toBeVisible();
  await expect(app.page.getByRole('button', {name: '自分', exact: true})).toBeVisible();
  await expect(app.page.locator('html')).toHaveAttribute('lang', 'ja');

  await app.open();
  await expect(app.main.getByRole('button', {name: 'プロフィールを編集する'})).toBeVisible();
});

test('in Japanese, the Remote, File and Inbox say each thing with the one word the catalog gives it', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.inbox.claim();
  await app.me.language('English', '日本語');

  await app.rail.go('remote');
  // A name in Latin letters is set apart from the Japanese around it by a space.
  const card = app.main.getByRole('group', {name: 'hello', exact: true});
  await expect(card).toContainText('Remote と同じ');
  await expect(card.getByRole('switch')).toHaveAccessibleName('hello をオフにする');

  await app.file.openTree();
  await expect(app.file.tree.getByRole('button', {name: 'hello の操作', exact: true})).toBeAttached();
  await app.file.close();

  await app.rail.go('inbox');
  await expect(app.main.getByRole('textbox', {name: '名前かコードに書く'})).toBeVisible();
});
