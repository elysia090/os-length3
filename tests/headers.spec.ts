import {expect, test} from './fixtures.ts';

// The app under the headers Workers Assets serves it with (public/_headers, which the preview serves
// too): the whole policy as a header, and no other page may frame it (security audit H1).

test('the app runs under its header policy, and another page that frames it gets nothing', async ({app, page, baseURL}) => {
  const answer = await page.request.get(baseURL!);
  expect(answer.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(answer.headers()['x-frame-options']).toBe('DENY');
  // The app itself ran under it: it is drawn, and nothing it did was refused by the policy.
  await expect(app.main).toBeVisible();
  const refused: string[] = [];
  page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) refused.push(m.text()); });
  await page.reload();
  await expect(app.main).toBeVisible();
  expect(refused).toEqual([]);

  // Another page (here, one with no origin of its own) frames the device-approval page: it stays empty.
  const other = await page.context().newPage();
  await other.setContent(`<iframe id="f" src="${baseURL}/?device&user_code=ABCDEFGH" width="800" height="600"></iframe>`);
  const frame = other.frameLocator('#f');
  // Blocked, the frame is the browser's own error page: none of the app is drawn in it, however long it waits.
  await other.waitForLoadState('load');
  await expect.poll(() => other.frames()[1]?.url() ?? '').toMatch(/^chrome-error:/);
  await expect(frame.getByRole('main')).toHaveCount(0);
  await expect(frame.getByRole('button')).toHaveCount(0);
  await other.close();
});
