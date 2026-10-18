import {expect, test} from './fixtures.ts';

// The language is chosen in the person's menu; the OS then speaks it at once,
// the rail and the page alike, and keeps speaking it the next time.

test('choosing 日本語 shows the page in Japanese, and it stays chosen', async ({app}) => {
  await app.rail.go('home');
  await expect(app.main.getByRole('button', {name: 'Edit profile'})).toBeVisible();

  await app.me.language('English', '日本語');

  await expect(app.main.getByRole('button', {name: 'プロフィールを編集する'})).toBeVisible();
  await expect(app.main.getByRole('heading', {name: '名前が未設定です'})).toBeVisible();
  await expect(app.page.getByRole('button', {name: '自分', exact: true})).toBeVisible();
  await expect(app.page.locator('html')).toHaveAttribute('lang', 'ja');

  await app.open();
  await expect(app.main.getByRole('button', {name: 'プロフィールを編集する'})).toBeVisible();
});
