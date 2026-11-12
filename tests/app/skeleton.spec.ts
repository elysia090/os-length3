import type {Locator} from '@playwright/test';
import {expect, test} from './fixtures.ts';
import type {App} from './app.ts';

// The skeleton every page is set on (styles/tokens.css): its own things start at one x, a counter's name is on the
// line the band's tools are on, its first line stands in the row Home's name does (the rail's first place), and its
// first box starts where Home's TODO does (the rail's second). Measured against Home at each width, so a page that
// goes its own way is told from one that moved with the rest.

const SIZES = [{width: 1440, height: 900}, {width: 1180, height: 900}, {width: 1024, height: 768}, {width: 390, height: 844}];
/** Where the one of `l` on screen is (a page left stays in the document, hidden). */
const at = async (l: Locator) => (await l.locator('visible=true').first().boundingBox())!;
const mid = (b: {y: number; height: number}) => b.y + b.height / 2;

/** Home's own lines at this width: where its things start, its band's middle, its name's row, its box's top. */
async function lines(app: App) {
  await app.rail.go('home');
  const name = await at(app.main.locator('.identity > h1')), todo = await at(app.main.locator('.todo-box'));
  return {left: name.x, band: mid(await at(app.main.locator('.band-tools > .band-tool'))), row: mid(name), rowTop: name.y, box: todo.y};
}

type Lines = Awaited<ReturnType<typeof lines>>;
/** `first` stands in the first row and `box` starts on the second, both from the page's own left edge. */
async function onRows(l: Lines, what: string, first: Locator | null, box: Locator) {
  await expect(async () => {
    const b = await at(box);
    expect(Math.abs(b.x - l.left), `${what}: its box's left edge`).toBeLessThan(1);
    expect(Math.abs(b.y - l.box), `${what}: its box's top`).toBeLessThan(1);
    if (first) expect(Math.abs(mid(await at(first)) - l.row), `${what}: its first line's middle`).toBeLessThan(1);
  }).toPass({timeout: 4000});
}
/** A counter's name is on the band's line, starting where the page's things do. */
async function headOnBand(app: App, l: Lines, what: string) {
  const head = await at(app.main.locator('.page-head > h1')), icon = await at(app.main.locator('.page-head > .icon'));
  expect(Math.abs(mid(head) - l.band), `${what}: its name's middle`).toBeLessThan(1);
  // (The icon's ink, not its square, is at the edge: common.ts inkAtEdge takes two to four pixels back.)
  expect(Math.abs(icon.x - l.left), `${what}: its head's left edge`).toBeLessThan(5);
}

test('signed out, every page starts at one left edge, its first line in one row and its first box on one line', async ({app}) => {
  await app.newRepo.make('hello', {template: 'C'});
  for (const size of SIZES) {
    await app.page.setViewportSize(size);
    const l = await lines(app), what = (page: string) => `${page} at ${size.width}×${size.height}`;
    await app.rail.go('new-repo');
    await app.newRepo.name.fill('count');
    await onRows(l, what('New repo'), null, app.main.locator('.nr-box'));
    // Git, signed out: the issues' heading over the place for the first.
    await app.rail.go('git');
    await onRows(l, what('Git'), app.main.locator('.issues-head'), app.main.locator('.issue-new'));
    await app.rail.go('runtime');
    await headOnBand(app, l, what('Runtime'));
    await onRows(l, what('Runtime'), app.main.locator('.part-bar'), app.main.locator('.part-panel:not([hidden])'));
    for (const part of ['Environments', 'Dotfiles', 'Agent'] as const) {
      await app.runtime.open(part);
      await onRows(l, what(`Runtime, ${part}`), app.main.locator('.part-bar'), app.main.locator('.part-panel:not([hidden])'));
    }
    // The pages that ask for a sign-in: the card is their first box, the row over it left for the parts to come.
    // (Server's is the same card under the same head, but only while no board on the Remote is open to everyone,
    // which another test may have made: not asked here.)
    for (const place of ['remote', 'inbox'] as const) {
      await app.rail.go(place);
      await headOnBand(app, l, what(place));
      await onRows(l, what(place), null, app.main.locator('.sign-in-card'));
    }
  }
});

test('signed in, Remote, Inbox and Server stand on the same lines, and behind Server\'s gear its parts take the second row', async ({signedIn: app}) => {
  await app.newRepo.make('hello', {template: 'C'});
  await app.inbox.named();
  await app.server.make('Length3', `len${Date.now() % 1e6}`);
  for (const size of SIZES) {
    await app.page.setViewportSize(size);
    const l = await lines(app), what = (page: string) => `${page} at ${size.width}×${size.height}`;
    // Git: main's name over what it has not committed.
    await app.rail.go('git');
    await onRows(l, what('Git'), app.main.locator('#main-title'), app.main.locator('.main-card'));
    await app.rail.go('remote');
    await headOnBand(app, l, what('Remote'));
    for (const part of ['Repos', 'Sign-in', 'Devices'] as const) {
      await app.remote.part(part).click();
      await onRows(l, what(`Remote, ${part}`), app.main.locator('.part-bar'), app.main.locator('.part-panel:not([hidden])'));
    }
    // Inbox: one's address is the first row's; the field to write to someone new starts the second.
    await app.rail.go('inbox');
    await headOnBand(app, l, what('Inbox'));
    await onRows(l, what('Inbox'), app.main.locator('.stub'), app.main.locator('.inbox-new'));
    // Server: the board's head is the first row (its sheet's top the row's), what it holds starts on the second
    // (a narrow board's head is two lines, its name and under it its parts: only its top is the row's).
    await app.server.open();
    const board = app.server.view.locator('.slide[aria-current="true"] .board-card');
    await expect(async () => {
      const b = await at(board), talk = await at(board.locator('.board-talk'));
      expect(Math.abs(b.x - l.left), `${what('Server')}: its board's left edge`).toBeLessThan(1);
      expect(Math.abs(b.y - l.rowTop), `${what('Server')}: its board's top`).toBeLessThan(1);
      if (size.width > 760) expect(Math.abs(talk.y - l.box), `${what('Server')}: its talk's top`).toBeLessThan(1.5);
    }).toPass({timeout: 4000});
    // Behind its gear: its name the first row's, its parts the second's, what the part holds from the third.
    await app.server.view.getByRole('button', {name: 'Manage members, boards, and repos'}).click();
    const sheet = app.server.view.locator('.server-sheet');
    await expect(async () => {
      const head = await at(sheet.locator('.sheet-head')), part = await at(sheet.locator('.sheet-body > .parts > .part')), panel = await at(sheet.locator('.part-panel:not([hidden])'));
      const row = l.box - l.rowTop;
      expect(Math.abs(head.x - l.left), `${what('Server settings')}: its left edge`).toBeLessThan(1);
      expect(Math.abs(mid(head) - l.row), `${what('Server settings')}: its name's middle`).toBeLessThan(1);
      expect(Math.abs(mid(part) - (l.row + row)), `${what('Server settings')}: its parts' middle`).toBeLessThan(1);
      expect(Math.abs(panel.y - (l.box + row)), `${what('Server settings')}: its part's top`).toBeLessThan(1);
    }).toPass({timeout: 4000});
    await app.server.view.getByRole('button', {name: 'Done', exact: true}).click();
  }
});
