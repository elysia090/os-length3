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
/** The two work desks replace the permanent frame with the same corner switch. */
async function workDesk(app: App, place: 'Forge' | 'Git', width: number) {
  await expect(app.page.getByRole('navigation', {name: 'Purposes', exact: true})).toBeHidden();
  await expect(app.rail.door).toBeHidden();
  const key = app.main.getByRole('button', {name: 'Places', exact: true});
  await expect(key).toBeVisible();
  expect(await key.boundingBox()).toMatchObject({x: width - 56, y: 12, width: 44, height: 44});
  await expect(app.main.getByRole('heading', {name: place, exact: true})).toBeVisible();
}
/** A sheet: paper from the desk's corner; where it is a place's far side, the door over its corner on the band's row. */
async function sheet(app: App, what: string, door: boolean) {
  await expect(async () => {
    await expect(app.rail.door).toBeVisible({visible: door});
    if (door) expect(await app.rail.door.boundingBox(), `${what}: its door`).toMatchObject({x: 2 * U, width: 2 * U});
    const page = await at(app.main);
    expect(Math.abs(page.x - 2 * U), `${what}: its left edge`).toBeLessThan(1);
    expect(Math.abs(page.y - 2 * U), `${what}: its top`).toBeLessThan(1);
    expect(await app.main.evaluate((el) => getComputedStyle(el).backgroundColor), `${what}: paper`).toBe('rgb(253, 250, 244)');
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
      if (place === 'forge' || place === 'git') await workDesk(app, place === 'forge' ? 'Forge' : 'Git', size.width);
      else await desk(app, what(place), place !== 'new-repo');
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

/** Server's held paper is the approved centered close-up, a full measure beneath the index on a phone. */
async function serverDesk(app: App, size: {width: number; height: number}) {
  const paper = app.server.paper;
  await expect(paper).toBeInViewport({ratio: 1});
  const w = (await paper.boundingBox())!;
  const index = (await app.server.topics.boundingBox())!;
  expect(Math.abs(w.x + w.width / 2 - size.width / 2)).toBeLessThan(2);
  if (size.width >= 1000 && size.height >= 684) {
    expect(w.width).toBe(Math.min(768, size.width - 480));
    expect(w.height).toBe(528);
    expect(index.x + index.width).toBeLessThan(w.x);
  } else expect(index.y + index.height).toBeLessThan(w.y);
  await expect(paper).toHaveCSS('background-color', 'rgb(239, 235, 227)');
  await expect(paper).toHaveCSS('box-shadow', 'rgb(26, 29, 23) 2px 4px 0px 0px');
}

async function inboxDesk(app: App, size: {width: number; height: number}) {
  const desk = size.width >= 1000;
  const x = desk ? 312 : 24, y = desk ? 96 : 72;
  const held = app.main.locator('.inbox-thread');
  await expect(app.rail.door).toBeHidden();
  await expect(app.forge.placesKey).toBeVisible();
  await expect(held).toBeInViewport({ratio: 1});
  expect(await held.boundingBox()).toEqual({x, y, width: Math.min(816, size.width - x - (desk ? 48 : 24)), height: Math.min(552, size.height - y - 38)});
  await expect(held).toHaveCSS('background-color', 'rgb(239, 235, 227)');
  await expect(held).toHaveCSS('box-shadow', 'rgb(26, 29, 23) 6px 6px 0px 0px');
  const index = app.inbox.conversations;
  if (desk) {
    await expect(index).toBeVisible();
    const left = await index.getByRole('heading', {name: 'Messages'}).boundingBox();
    expect(left?.x).toBe(48);
  } else await expect(index).toBeHidden();
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
    await workDesk(app, 'Git', size.width);
    await app.rail.go('remote');
    await sheet(app, what('remote'), true);
    await app.rail.go('inbox');
    await inboxDesk(app, size);
    expect(await sideways(app), what('Inbox')).toBeLessThanOrEqual(0);
    await app.server.open();
    await serverDesk(app, size);
    expect(await sideways(app), what('Server')).toBeLessThanOrEqual(0);
  }
});
