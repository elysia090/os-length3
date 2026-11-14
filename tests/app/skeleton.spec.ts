import type {Locator} from '@playwright/test';
import {expect, test} from './fixtures.ts';
import type {App} from './app.ts';

// The skeleton every place is set on (styles/tokens.css, base.css): the frame is the rail's column and the band's row,
// two cells each, and the world starts at their corner, 48 px in and 48 down, at every width (a phone's too: there is
// no other skeleton for a narrow window). A place is a desk (Home, New repo, Forge, Git), its band one bar from the
// desk's edge, 36 px tall about the row's middle; or one thing to read (Runtime, Remote, Inbox), a sheet of paper from
// the desk's corner. A place that goes its own way is told from one that stands with the rest.

const SIZES = [{width: 1440, height: 900}, {width: 1180, height: 900}, {width: 1024, height: 768}, {width: 390, height: 844}];
const U = 24;
/** Where the one of `l` on screen is (a page left stays in the document, hidden). */
const at = async (l: Locator) => (await l.locator('visible=true').first().boundingBox())!;

/** A desk: its band is one bar from the desk's edge on the row of the rail's first place, whole cells wide. */
async function desk(app: App, what: string) {
  await expect(async () => {
    const bar = await at(app.main.locator('.band-tools')), first = await at(app.rail.button('home'));
    expect(Math.abs(bar.x - 2 * U), `${what}: its band's left edge`).toBeLessThan(1);
    expect(Math.abs(bar.y - first.y), `${what}: its band's top, the rail's first place's`).toBeLessThan(1);
    expect(Math.abs(bar.height - first.height), `${what}: its band as tall as a place`).toBeLessThan(1);
    expect(bar.width % U, `${what}: its band whole cells wide`).toBeLessThan(1);
  }).toPass({timeout: 4000});
}
/** A sheet: paper from the desk's corner. */
async function sheet(app: App, what: string) {
  await expect(async () => {
    const page = await at(app.main);
    expect(Math.abs(page.x - 2 * U), `${what}: its left edge`).toBeLessThan(1);
    expect(Math.abs(page.y - 2 * U), `${what}: its top`).toBeLessThan(1);
    expect(await app.main.evaluate((el) => getComputedStyle(el).backgroundColor), `${what}: paper`).toBe('rgb(251, 250, 247)');
  }).toPass({timeout: 4000});
}
/** The ground is the desk's dots, under every place. */
const dotted = (app: App) => app.page.evaluate(() => getComputedStyle(document.body).backgroundImage.includes('radial-gradient'));
/** How far the page is wider than the window (it never is). */
const sideways = (app: App) => app.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test('signed out, every place starts at the frame\'s corner: a desk\'s band from the desk\'s edge, a sheet from the desk\'s corner, at every width', async ({app}) => {
  await app.newRepo.make('hello', {template: 'C'});
  for (const size of SIZES) {
    await app.page.setViewportSize(size);
    const what = (page: string) => `${page} at ${size.width}×${size.height}`;
    for (const place of ['home', 'new-repo', 'forge', 'git'] as const) {
      await app.rail.go(place);
      await desk(app, what(place));
      expect(await dotted(app), what(place)).toBe(true);
      expect(await sideways(app), what(place)).toBeLessThanOrEqual(0);
    }
    for (const place of ['runtime', 'remote', 'inbox'] as const) {
      await app.rail.go(place);
      await sheet(app, what(place));
      expect(await dotted(app), what(place)).toBe(true);
      expect(await sideways(app), what(place)).toBeLessThanOrEqual(0);
    }
  }
});

test('signed in, Remote and Inbox are sheets from the desk\'s corner still, and Server\'s board is whole in the window', async ({signedIn: app}) => {
  await app.newRepo.make('hello', {template: 'C'});
  await app.inbox.named();
  await app.server.make('Length3', `len${Date.now() % 1e6}`);
  for (const size of SIZES) {
    await app.page.setViewportSize(size);
    const what = (page: string) => `${page} at ${size.width}×${size.height}`;
    await app.rail.go('git');
    await desk(app, what('Git'));
    for (const place of ['remote', 'inbox'] as const) {
      await app.rail.go(place);
      await sheet(app, what(place));
    }
    await app.server.open();
    const board = app.server.view.locator('.slide[aria-current="true"] .board-card');
    await expect(async () => {
      const b = await at(board);
      expect(b.x, `${what('Server')}: its board's left edge`).toBeGreaterThanOrEqual(2 * U - 1);
      expect(b.x + b.width, `${what('Server')}: its board's right edge`).toBeLessThanOrEqual(size.width);
    }).toPass({timeout: 4000});
    expect(await sideways(app), what('Server')).toBeLessThanOrEqual(0);
  }
});
