import type {Locator} from '@playwright/test';
import {expect, test} from './fixtures.ts';
import type {App} from './app.ts';

// The skeleton every place is set on (styles/tokens.css, base.css): the frame is the rail's column and the band's row,
// two cells each, and the world starts at their corner, 48 px in and 48 down, at every width (a phone's too: there is
// no other skeleton for a narrow window). A place is a desk (Home, New repo, Forge, Git), its band one bar from the
// desk's edge, 36 px tall about the row's middle; or one thing to read (Runtime, the Remote; Inbox signed out), a sheet
// of paper from the desk's corner; or a desk with a row (Server, Inbox). A place that goes its own way is told from one
// that stands with the rest.

const SIZES = [{width: 1440, height: 900}, {width: 1180, height: 900}, {width: 1024, height: 768}, {width: 390, height: 844}];
const U = 24;
/** Where the one of `l` on screen is (a page left stays in the document, hidden). */
const at = async (l: Locator) => (await l.locator('visible=true').first().boundingBox())!;

/** A desk: its band is one bar from the desk's edge on the row of the rail's first place, whole cells wide; where the
 * place has a far side (or is one), the door is the bar's first two cells. */
async function desk(app: App, what: string, door: boolean) {
  await expect(async () => {
    const bar = await at(app.main.locator('.band-tools')), first = await at(app.rail.button('home'));
    await expect(app.rail.door).toBeVisible({visible: door});
    const from = door ? (await app.rail.door.boundingBox())! : bar;
    if (door) {
      expect([from.width, from.height, from.y], `${what}: its door two cells wide, on the band's row`).toEqual([2 * U, first.height, first.y]);
      expect(Math.abs(bar.x - (from.x + from.width)), `${what}: its band goes on from the door`).toBeLessThan(1);
    }
    expect(Math.abs(from.x - 2 * U), `${what}: its band's left edge`).toBeLessThan(1);
    expect(Math.abs(bar.y - first.y), `${what}: its band's top, the rail's first place's`).toBeLessThan(1);
    expect(Math.abs(bar.height - first.height), `${what}: its band as tall as a place`).toBeLessThan(1);
    expect((bar.x + bar.width - from.x) % U, `${what}: its band whole cells wide`).toBeLessThan(1);
  }).toPass({timeout: 4000});
}
/** A sheet: paper from the desk's corner; where it is a place's far side, the door over its corner on the band's row. */
async function sheet(app: App, what: string, door: boolean) {
  await expect(async () => {
    await expect(app.rail.door).toBeVisible({visible: door});
    if (door) expect(await app.rail.door.boundingBox(), `${what}: its door`).toMatchObject({x: 2 * U, width: 2 * U});
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
      await desk(app, what(place), place !== 'new-repo');
      expect(await dotted(app), what(place)).toBe(true);
      expect(await sideways(app), what(place)).toBeLessThanOrEqual(0);
    }
    for (const place of ['runtime', 'remote', 'inbox'] as const) {
      await app.rail.go(place);
      await sheet(app, what(place), place !== 'runtime');
      expect(await dotted(app), what(place)).toBe(true);
      expect(await sideways(app), what(place)).toBeLessThanOrEqual(0);
    }
  }
});

/**
 * A desk with a row (Server, Inbox: DESIGN §6): the piece in the hand whole in the window, from a cell under the band
 * to a cell over the window's foot, as wide as the window has whole cells for (24 at most), paper with its shadow;
 * and with the desk at the row's start, the row's first sheet at the desk's edge, `cells` wide, the piece two cells on.
 */
async function row(what: string, size: {width: number; height: number}, first: Locator, cells: number, held: Locator) {
  await expect(async () => {
    const p = await at(held);
    const wide = U * Math.min(24, Math.max(10, Math.floor((size.width - 2 * U - 2 - U / 2) / U)));
    expect(Math.abs(p.width - wide), `${what}: its piece ${wide / U} cells wide`).toBeLessThan(1);
    expect(p.x, `${what}: its piece's left edge in the window`).toBeGreaterThanOrEqual(2 * U - 1);
    expect(p.x + p.width + U / 2, `${what}: its piece and its shadow in the window`).toBeLessThanOrEqual(size.width);
    expect(Math.abs(p.y - 3 * U), `${what}: its piece's top a cell under the band`).toBeLessThan(1);
    expect(Math.abs(p.y + p.height - (size.height - U)), `${what}: its piece's foot a cell over the window's`).toBeLessThan(1);
    const look = await held.evaluate((el) => { const c = getComputedStyle(el); return [c.backgroundColor, c.boxShadow !== 'none']; });
    expect(look, `${what}: its piece in the hand is paper with its shadow`).toEqual(['rgb(251, 250, 247)', true]);
    const f = await first.boundingBox();
    // The desk at the row's start (a window with room for both): the first sheet at the desk's edge.
    if (f && f.x >= 0) {
      expect([Math.round(f.x), Math.round(f.width)], `${what}: its first sheet at the desk's edge, ${cells} cells`).toEqual([2 * U, cells * U]);
      expect(Math.round(p.x - (f.x + f.width)) % (26 * U), `${what}: its piece two cells on, or a piece and two cells further`).toBe(2 * U);
      expect(await first.evaluate((el) => getComputedStyle(el).boxShadow), `${what}: its first sheet is not in the hand`).toBe('none');
    }
  }).toPass({timeout: 4000});
}

test('signed in, the Remote is a sheet from the desk\'s corner still; Server and Inbox are desks with a row, the piece in the hand whole in the window', async ({signedIn: app, another}) => {
  const bo = await another('Bo');
  await bo.inbox.named();
  await app.newRepo.make('hello', {template: 'C'});
  await app.inbox.named();
  await app.inbox.writeTo(bo.handle, 'Hello');
  await app.server.make('Length3', `len${Date.now() % 1e6}`);
  for (const size of SIZES) {
    await app.page.setViewportSize(size);
    const what = (page: string) => `${page} at ${size.width}×${size.height}`;
    await app.rail.go('git');
    await desk(app, what('Git'), true);
    await app.rail.go('remote');
    await sheet(app, what('remote'), true);
    await app.rail.go('inbox');
    await expect(app.rail.door).toBeVisible();
    await row(what('Inbox'), size, app.main.locator('.inbox-index'), 12, app.main.locator('.inbox-thread'));
    expect(await sideways(app), what('Inbox')).toBeLessThanOrEqual(0);
    await app.server.open();
    await row(what('Server'), size, app.server.side, 8, app.server.view.locator('.slide[aria-current="true"]'));
    expect(await sideways(app), what('Server')).toBeLessThanOrEqual(0);
  }
});
