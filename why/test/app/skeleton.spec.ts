import type {Locator} from '@playwright/test';
import {expect, test} from './fixtures.ts';
import type {App} from './app.ts';

// New repo retains the framed band. Home, the work desks and Runtime share the labelled Places and Search, not a permanent rail.
// The Remote still frames a sheet; Inbox uses its own desk on either side of sign-in.
const SIZES = [{width: 1440, height: 900}, {width: 1180, height: 900}, {width: 1024, height: 768}, {width: 390, height: 844}];
const U = 24;
/** Where the one of `l` on screen is (a page left stays in the document, hidden). */
const at = async (l: Locator) => (await l.locator('visible=true').first().boundingBox())!;

/** New repo still has a whole-cell band on the rail's first row, with no door. */
async function newRepoDesk(app: App, what: string) {
  await expect(async () => {
    const bar = await at(app.main.getByRole('group', {name: 'Tools', exact: true}));
    const first = await at(app.rail.button('home'));
    await expect(app.rail.door).toBeHidden();
    expect(bar.x, `${what}: band's left edge`).toBe(2 * U);
    expect([bar.y, bar.height], `${what}: band on the rail's first row`).toEqual([first.y, first.height]);
    expect(bar.width % U, `${what}: band whole cells wide`).toBeLessThan(1);
  }).toPass({timeout: 4000});
}

/** The corner supplies the frame, not two ways to do the same work. */
async function corner(app: App, width: number) {
  await expect(app.page.getByRole('navigation', {name: 'Purposes', exact: true, includeHidden: true})).toBeHidden();
  await expect(app.rail.door).toBeHidden();
  const lens = app.main.getByRole('button', {name: 'Search', exact: true});
  await expect(lens).toBeVisible();
  expect(await lens.boundingBox()).toEqual({x: width - 12 - 44, y: 12, width: 44, height: 44});
  const key = app.forge.placesKey;
  await expect(key).toBeVisible();
  const {x, y, height} = await at(key.locator('.places-label'));
  expect([x, y, height]).toEqual([width <= 1000 ? U : 2 * U, U, U]);
}

async function homeDesk(app: App, width: number) {
  await corner(app, width);
  await expect(app.main.getByRole('group', {name: 'Tools', exact: true})).toBeHidden();
  const line = width <= 600 ? U : 2 * U;
  const name = app.main.locator('.home-portrait').getByRole('heading', {level: 1});
  const note = app.home.todo;
  await expect(name).toBeVisible();
  await expect(note).toBeVisible();
  const portrait = await at(name), paper = await at(note);
  expect(portrait.x).toBe(line);
  expect(paper.x).toBe(line);
  expect(paper.y).toBeGreaterThanOrEqual(portrait.y + portrait.height);
  expect(paper.width).toBe(width <= 600 ? 14 * U : 26 * U);
  await expect(note).toHaveCSS('background-color', 'rgb(215, 197, 90)');
}

async function workDesk(app: App, place: 'Forge' | 'Git', width: number) {
  await corner(app, width);
  await expect(app.main.getByRole('heading', {name: place, exact: true})).toBeVisible();
}
/** A sheet: paper from the desk's corner; where it is a place's far side, the door over its corner on the band's row. */
async function sheet(app: App, what: string, door: boolean, paper = 'rgb(253, 250, 244)') {
  await expect(async () => {
    await expect(app.rail.door).toBeVisible({visible: door});
    if (door) expect(await app.rail.door.boundingBox(), `${what}: its door`).toMatchObject({x: 2 * U, width: 2 * U});
    const page = await at(app.main);
    expect(Math.abs(page.x - 2 * U), `${what}: its left edge`).toBeLessThan(1);
    expect(Math.abs(page.y - 2 * U), `${what}: its top`).toBeLessThan(1);
    expect(await app.main.evaluate((el) => getComputedStyle(el).backgroundColor), `${what}: paper`).toBe(paper);
  }).toPass({timeout: 4000});
}
async function runtimeDesk(app: App, width: number) {
  await corner(app, width);
  const narrow = width <= 600, measure = 40 * U;
  const left = narrow ? U : Math.max(2 * U, Math.min(9 * U, Math.floor((width - measure - U) / (2 * U)) * U));
  const paper = app.main.locator('.runtime-paper');
  const tabs = app.main.getByRole('tablist', {name: 'Runtime'});
  await expect(paper).toBeVisible();
  await expect(tabs).toBeVisible();
  const b = await at(paper), row = await at(app.main.locator('.runtime-tabs'));
  expect([b.x, b.y, b.width]).toEqual([left, narrow ? 4.5 * U : 4 * U, Math.min(measure, width - left - U)]);
  expect([row.x, row.y + row.height]).toEqual([b.x, b.y]);
  expect(await paper.locator('h1, [role="tablist"]').count()).toBe(0);
  await expect(paper).toHaveCSS('background-color', 'rgb(239, 235, 227)');
  await expect(app.main).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
}

/** The ground is the desk's dots, under every place. */
const dotted = (app: App) => app.page.evaluate(() => getComputedStyle(document.body).backgroundImage.includes('radial-gradient'));
/** How far the page is wider than the window (it never is). */
const sideways = (app: App) => app.page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

test('signed out, each place keeps its own frame and reading edge at every width', async ({app}) => {
  await app.newRepo.make('hello', {template: 'C'});
  for (const size of SIZES) {
    await app.page.setViewportSize(size);
    const what = (page: string) => `${page} at ${size.width}×${size.height}`;
    for (const place of ['home', 'new-repo', 'forge', 'git'] as const) {
      await app.rail.go(place);
      if (place === 'home') await homeDesk(app, size.width);
      else if (place === 'new-repo') await newRepoDesk(app, what(place));
      else await workDesk(app, place === 'forge' ? 'Forge' : 'Git', size.width);
      expect(await dotted(app), what(place)).toBe(true);
      expect(await sideways(app), what(place)).toBeLessThanOrEqual(0);
    }
    for (const place of ['runtime', 'remote'] as const) {
      await app.rail.go(place);
      if (place === 'runtime') await runtimeDesk(app, size.width);
      else await sheet(app, what(place), true);
      expect(await dotted(app), what(place)).toBe(true);
      expect(await sideways(app), what(place)).toBeLessThanOrEqual(0);
    }
    await app.rail.go('inbox');
    await corner(app, size.width);
    await expect(app.main.getByRole('heading', {name: 'Inbox', level: 1, exact: true})).toBeVisible();
    const signIn = app.main.getByRole('region', {name: 'Sign in', exact: true});
    await expect(signIn.getByRole('button', {name: 'Continue with Development', exact: true})).toBeVisible();
    const {x, y, width} = await at(signIn);
    expect([x, y, width], what('inbox')).toEqual(size.width >= 1000 ? [312, 96, 440] : [24, 72, size.width - 48]);
    await expect(signIn).toHaveCSS('background-color', 'rgb(239, 235, 227)');
    expect(await dotted(app), what('inbox')).toBe(true);
    expect(await sideways(app), what('inbox')).toBeLessThanOrEqual(0);
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
  await corner(app, size.width);
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
