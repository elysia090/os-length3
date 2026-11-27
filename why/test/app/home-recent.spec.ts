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
