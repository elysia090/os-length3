import {expect, test} from './fixtures.ts';
import type {Thread} from '../../shipto/inbox.ts';

test('Home keeps Recent while the same account returns, but leaves no letters on logout', async ({signedIn: app}) => {
  const {page, main} = app;
  await page.route('**/webroot/**', route => route.abort());
  const thread: Thread = {address: 'reader@fixture.invalid', name: 'Fixture reader', state: 'contact', unread: 1,
    last: {type: 'message', body: 'Earlier account fixture line.\nNot a Recent excerpt.', mine: false, time: Date.now()}};
  let hold = false, waiting!: () => void, release!: () => void;
  const asked = new Promise<void>(done => { waiting = done; });
  const answer = new Promise<void>(done => { release = done; });
  await page.route('**/v1/inbox/threads', async (route) => {
    if (hold) { waiting(); await answer; }
    await route.fulfill({json: [thread]});
  });
  const recent = main.getByRole('region', {name: 'Recent activity', exact: true});
  const previous = recent.getByRole('button', {name: /Fixture reader/});
  // A real local file is still available while the signed-out desk re-reads it.
  await app.newRepo.make('recent-scope');
  await app.forge.editFile('README.md', '# recent-scope\n\nUntouched local return line.\n');
  await app.forge.editor('README.md').press('Control+End');
  await app.rail.go('home');
  await expect(recent.getByRole('button', {name: /Continue where you left off/})).toContainText('Untouched local return line.');
  await expect(previous).toContainText('Earlier account fixture line.');
  await expect(previous).not.toContainText('Not a Recent excerpt.');
  try {
    hold = true;
    await app.rail.go('runtime');
    await app.rail.go('home');
    await asked;
    await expect(previous).toBeVisible(); // Same account; the newer read is deliberately still pending.
    await main.evaluate((page) => {
      page.setAttribute('data-test-recent-remounts', '0');
      const watcher = new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement) || !node.matches('.home-portrait .lately-list, .home-portrait')) continue;
          const activity = node.matches('.lately-list') ? node : node.querySelector('.lately-list');
          if (activity?.textContent?.includes('Earlier account fixture line.')) {
            page.setAttribute('data-test-recent-remounts', String(Number(page.getAttribute('data-test-recent-remounts')) + 1));
          }
        }
      });
      watcher.observe(page, {childList: true, subtree: true});
    });
    await app.me.signOut();
    await expect(previous).toHaveCount(0);
    await expect(recent.getByRole('button', {name: /Continue where you left off/})).toBeVisible();
    const answered = page.waitForResponse('**/v1/inbox/threads');
    release();
    await (await answered).finished();
    // Delayed old data cannot appear on this new desk, or seed the next signed-out visit.
    await expect(main).toHaveAttribute('data-test-recent-remounts', '0');
    await app.rail.go('runtime');
    await app.rail.go('home');
    await expect(previous).toHaveCount(0);
    await expect(main).toHaveAttribute('data-test-recent-remounts', '0');
    await recent.getByRole('button', {name: /Continue where you left off/}).click();
    await expect(app.forge.editor('README.md')).toHaveValue(/Untouched local return line\./);
  } finally { release(); }
});

test('Home dates real Recent rows, with Earlier and a scroll thumb inset 9px from the glass', async ({signedIn: app}) => {
  const {page, main} = app;
  await page.setViewportSize({width: 1536, height: 864});
  await page.route('**/webroot/**', route => route.abort());
  const now = new Date();
  const when = (days: number, hours: number, minutes: number) =>
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - days, hours, minutes);
  const times = [when(0, 10, 42), when(0, 9, 18), when(1, 17, 15), when(1, 15, 24), when(1, 14, 48), when(2, 18, 3), when(2, 11, 16)];
  const threads: Thread[] = times.map((time, i) => ({
    address: `reader-${i}@fixture.invalid`, name: `Reader ${i + 1}`, state: 'contact', unread: 1,
    last: {type: 'message', body: `Their actual first line ${i + 1}.\nNot a Recent excerpt.`, mine: false, time},
  })).reverse() as Thread[];
  await page.route('**/v1/inbox/threads', route => route.fulfill({json: threads}));
  await app.rail.go('runtime');
  await app.rail.go('home');

  const recent = main.getByRole('region', {name: 'Recent activity', exact: true});
  const timeline = recent.getByRole('region', {name: 'Activity timeline'});
  const rows = timeline.locator('.home-recent-line:not([hidden])');
  const headings = timeline.locator('.home-recent-day');
  const thumb = recent.locator('.home-recent-thumb');
  const earlier = recent.getByRole('button', {name: 'Earlier 4 ↓'});
  await expect(rows).toHaveCount(3);
  await expect(rows.locator('time')).toHaveText(['10:42', '09:18', '17:15']);
  await expect(rows.first()).toContainText('Reader 1 · Their actual first line 1.');
  await expect(rows.first()).not.toContainText('Not a Recent excerpt.');
  await expect(headings.nth(0).getByRole('heading')).toHaveText('Today');
  await expect(headings.nth(1).getByRole('heading')).toHaveText('Yesterday');
  await expect(thumb).toBeHidden();
  await earlier.click();
  await expect(rows).toHaveCount(7);
  await expect(timeline).toBeFocused();
  await expect(thumb).toBeVisible();
  await expect(headings.nth(1)).not.toHaveAttribute('data-orphan-rule', '');
  await expect(headings.nth(2)).toHaveAttribute('data-orphan-rule', '');
  const track = await thumb.evaluate(el => {
    const r = el.getBoundingClientRect(), style = getComputedStyle(el, '::before');
    const glass = el.closest('.lately')!.querySelector('.home-recent-glass')!.getBoundingClientRect();
    const start = r.left + Number.parseFloat(style.left), end = r.right - Number.parseFloat(style.right);
    return {width: end - start, gap: glass.right - end, x: (start + end) / 2, y: r.top + 20};
  });
  expect(track).toMatchObject({width: 4, gap: 9});
  await page.mouse.move(track.x, track.y);
  await page.mouse.down();
  await page.mouse.move(track.x, track.y + 45, {steps: 3});
  await page.mouse.up();
  await expect.poll(() => timeline.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await timeline.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect(headings.nth(2)).not.toHaveAttribute('data-orphan-rule', '');
  await timeline.evaluate(el => { el.scrollTop = 0; });
  await timeline.press('PageDown');
  await expect.poll(() => timeline.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await timeline.evaluate(el => { el.scrollTop = 0; });
  await page.mouse.move(track.x - 80, track.y + 55);
  await page.mouse.wheel(0, 160);
  await expect.poll(() => timeline.evaluate(el => el.scrollTop)).toBeGreaterThan(0);

  await recent.getByRole('button', {name: 'Show less ↑'}).click();
  await expect(earlier).toBeFocused();
  await expect(rows).toHaveCount(3);
  await expect(thumb).toBeHidden();
  await page.setViewportSize({width: 390, height: 844});
  await earlier.click();
  await expect(rows).toHaveCount(7);
  await expect(timeline).toHaveCSS('overflow-y', 'visible');
  await expect(thumb).toBeHidden();
});
