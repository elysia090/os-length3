import {expect, test} from './fixtures.ts';

// New repo (+): a name, what it is for (into its README, under the title),
// and the one scaffold (a README and docs/; its issues' place is the OS's, made with the first), its file named in the box (nothing to choose); made,
// it is gone into in Forge, the caret in its README. A name taken is said under the name, with
// the keyboard back on it. What is written stays while other pages are seen.

test('with no repo at all, Forge and Git offer to make the first, and that is New repo', async ({app}) => {
  for (const place of ['forge', 'git'] as const) {
    await app.rail.go(place);
    if (place === 'forge') await app.main.getByRole('button', {name: 'Open Folder', exact: true}).click();
    const where = place === 'forge' ? app.page.getByRole('dialog', {name: 'Open Folder'}) : app.main;
    const first = where.getByRole('button', {name: /^Create your first repo/});
    await expect(first).toBeVisible();
    await first.click();
    await expect(app.rail.button('new-repo')).toHaveAttribute('aria-current', 'page');
  }
});

test('a repo made from the scaffold has its README, its summary under the title, and no language of its own', async ({signedIn: app}) => {
  await app.newRepo.make('hello', {summary: 'Says hello.'});
  await expect(app.forge.editor('README.md')).toHaveValue('# hello\n\nSays hello.\n');
  await expect(app.forge.editor('README.md')).toBeFocused();
  // C's files are `why repo new -t c`'s, not every repo's.
  await expect(app.forge.editor('src/main.c')).toHaveCount(0);
  await expect(app.forge.editor('Makefile')).toHaveCount(0);
});

test('what will be made is the new repo alone, as File will show it, its files made, renamed and left out there first', async ({app}) => {
  await app.newRepo.make('tide', {summary: 'Tide tables.'});
  await expect(app.forge.editor('README.md')).toHaveValue('# tide\n\nTide tables.\n');
  await app.rail.go('new-repo');
  // There is nothing to choose, and nothing to name in the box.
  await expect(app.main.getByRole('radiogroup')).toHaveCount(0);
  const card = app.main.locator('.tree-still');
  await app.newRepo.name.fill('harbour');
  // What will be in it, nothing else of the device's (no /root, no tide); the repo itself is the sheet, named once.
  await expect(card.locator('.tree-row')).toHaveText([/^docs/, /^README\.md/]);
  // New file: a row named as nothing is yet, its name a field to write over (its ending kept); New folder, a path.
  await card.getByRole('button', {name: 'New file'}).click();
  const field = card.getByRole('textbox', {name: 'New name'});
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('untitled.md');
  await app.page.keyboard.type('tides');
  await field.press('Enter');
  await card.getByRole('button', {name: 'New folder'}).click();
  await app.page.keyboard.type('charts/2031');
  await card.getByRole('textbox', {name: 'New name'}).press('Enter');
  // Renamed where it stands; the issues' place is the OS's, said under the card, the name kept to be put right.
  await card.getByRole('button', {name: 'docs', exact: true}).click();
  await card.getByRole('textbox', {name: 'New name'}).fill('issue');
  await card.getByRole('textbox', {name: 'New name'}).press('Enter');
  await expect(card.getByRole('alert')).toHaveText('"issue" is where the repo\'s issues are kept');
  await card.getByRole('textbox', {name: 'New name'}).fill('notes');
  await card.getByRole('textbox', {name: 'New name'}).press('Enter');
  await expect(card.locator('p.error')).toHaveText('');
  // Left out, from its one mark's menu: it goes from the card, and will not be made.
  await card.getByRole('button', {name: 'Actions for notes'}).click();
  await app.page.getByRole('menuitem', {name: 'Leave out notes'}).click();
  await expect(card.locator('li[data-path="notes"]')).toHaveCount(0);
  await expect(card.locator('.tree-row')).toHaveText([/^charts/, /^2031/, /^README\.md/, /^tides\.md/]);
  // Made as laid out: the README what it is for, the new file empty, the folders there, docs not.
  await app.newRepo.summary.fill('Moorings.');
  await app.newRepo.create.click();
  await expect(app.forge.editor('README.md')).toHaveValue('# harbour\n\nMoorings.\n');
  for (const path of ['tides.md', 'charts/2031']) await app.file.item('harbour', path);
  await expect((await app.file.item('harbour', '', {open: true})).getByRole('treeitem', {name: 'docs', exact: true})).toHaveCount(0);
});

test('New repo is one piece at the desk\'s edge, the hand\'s: on the grid, a piece wide, its name at a name\'s size on its first line, what will be made inside it under a rule', async ({app}) => {
  const U = 24, NAME = 24 / .727;
  for (const size of [{width: 1400, height: 900}, {width: 390, height: 844}]) {
    await app.page.setViewportSize(size);
    await app.rail.go('new-repo');
    const box = app.main.locator('.nr-box'), label = app.main.locator('.nr-label');
    await app.newRepo.name.fill('count');
    // A piece wide (24 cells, or as many whole cells as the window has room for with its shadow), its place in the
    // cell over its corner, its top a cell under the band, its foot on a line of the grid.
    const wide = U * Math.min(24, Math.max(10, Math.floor((size.width - 2 * U - U / 2) / U)));
    await expect(async () => {
      const b = (await box.boundingBox())!, l = (await label.boundingBox())!;
      expect([b.x, b.y, b.width], `the piece at ${size.width}`).toEqual([2 * U, 3 * U, wide]);
      expect(b.height % U).toBe(0);
      expect([l.x, l.y, l.height]).toEqual([2 * U, 2 * U, U]);
    }).toPass();
    // The hand's: paper, the one light's shadow; and the only shadow on the desk.
    expect(await box.evaluate((e) => getComputedStyle(e).boxShadow)).toBe('rgb(23, 22, 21) 12px 12px 0px 0px');
    expect(await app.main.evaluate((m) => [...m.querySelectorAll('*')].filter((e) => getComputedStyle(e).boxShadow.includes('12px 12px')).length)).toBe(1);
    // The name at a name's size, never fitted to its room, its capitals on the box's first line of the grid, a cell in.
    const name = await app.newRepo.name.evaluate((e: HTMLInputElement) => {
      const b = e.closest('.nr-box')!.getBoundingClientRect(), n = e.getBoundingClientRect(), cs = getComputedStyle(e);
      return {size: parseFloat(cs.fontSize), left: n.left + parseFloat(cs.paddingLeft) - b.left, top: n.top - b.top};
    });
    expect(Math.abs(name.size - NAME)).toBeLessThan(.01);
    expect(name.left).toBe(U);
    expect(Math.abs(name.top - (U - .2043 * U))).toBeLessThan(1);
    await app.newRepo.name.fill('length3-blobs-mirror-of-main-and-more');
    expect(Math.abs(await app.newRepo.name.evaluate((e) => parseFloat(getComputedStyle(e).fontSize)) - NAME)).toBeLessThan(.01);
    // What will be made is inside it, under a rule, under what it is for.
    const files = box.locator('.tree-still');
    await expect(files).toBeVisible();
    expect(await files.evaluate((e) => getComputedStyle(e).borderTopWidth)).toBe('1px');
    // Its inside on the grid (DESIGN §3, whole cells): from the rule down, every line of it on a cell, a cell tall;
    // the key under them the frame's square in a field of two cells. One size of words on it, and the name's.
    const sheet = await box.evaluate((b) => {
      const top = b.getBoundingClientRect().top;
      const lines = [...b.querySelectorAll('.tree-still, .tree-row, .tree-makes, .answers .button')].map((e) => {
        const r = e.getBoundingClientRect();
        return {what: e.className.toString(), top: r.top - top, height: r.height};
      });
      const sizes = new Set<string>();
      const walk = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const el = n.parentElement!;
        if (n.textContent!.trim() && el.getBoundingClientRect().width && !el.closest('.sr-only, kbd')) sizes.add(getComputedStyle(el).fontSize);
      }
      // Nothing in it filled but its key, and nothing on it coloured by the pointer there.
      const filled = [...b.querySelectorAll('*')].filter((e) => !e.closest('.answers') && getComputedStyle(e).backgroundColor === 'rgb(23, 22, 21)').length;
      return {lines, sizes: [...sizes].sort(), filled};
    });
    for (const l of sheet.lines) {
      const key = /button/.test(l.what);
      expect((l.top - (key ? U / 4 : 0)) % U, `${l.what} at ${l.top}, on a cell${key ? ' (a key: a quarter cell into its field)' : ''}`).toBe(0);
      expect(key ? l.height : l.height % U, `${l.what} ${l.height} tall`).toBe(key ? 1.5 * U : 0);
    }
    expect(sheet.sizes, 'the words on it at the words\' size, one size (DESIGN §3)').toEqual(['17px']);
    expect(sheet.filled, 'nothing filled in it but its key').toBe(0);
    // Its place over its corner stands on a patch of the ground, no dot of the grid under its words.
    expect(await label.evaluate((e) => [getComputedStyle(e).backgroundColor, e.getBoundingClientRect().width <= e.scrollWidth + 1])).toEqual(['rgb(220, 217, 212)', true]);
    // Each row's deeds are one mark, a chevron, always there.
    await expect(files.locator('li[data-path="README.md"] button[aria-haspopup="menu"]')).toHaveCount(1);
    await expect(files.locator('li[data-path="README.md"] button:not([aria-haspopup]):not(.tree-name)')).toHaveCount(0);
  }
});

test('what is written before Create stays while another page is seen, and goes once made', async ({app}) => {
  await app.rail.go('new-repo');
  await app.newRepo.name.fill('harbour');
  await app.newRepo.summary.fill('Tide tables for the harbour.');

  await app.rail.go('runtime');
  await app.rail.go('new-repo');
  await expect(app.newRepo.name).toHaveValue('harbour');
  await expect(app.newRepo.summary).toHaveValue('Tide tables for the harbour.');

  await app.newRepo.create.click();
  await expect(app.newRepo.madeIn('harbour')).toBeVisible();
  await app.rail.go('runtime');
  await app.rail.go('new-repo');
  await expect(app.newRepo.name).toHaveValue('');
  await expect(app.newRepo.summary).toHaveValue('');
});

test('nothing named yet, the name\'s place says so quietly and Create asks for one first; a letter no name can have is marked where the name stands over the corner', async ({app}) => {
  await app.rail.go('new-repo');
  // The field holds no example to be taken for a name: the word for what goes there, quiet, where the name will stand.
  await expect(app.newRepo.name).toHaveValue('');
  await expect(app.newRepo.name).not.toHaveAttribute('placeholder');
  await expect(app.main.locator('.nr-box')).toHaveAttribute('data-empty', 'name');
  await expect(app.newRepo.problem).toBeHidden();
  await app.newRepo.create.click();
  await expect(app.newRepo.problem).toHaveText('Please enter a name first');
  await expect(app.newRepo.name).toBeFocused();
  // Written, it stands over the corner as it is written; a space in it is no letter of a name, marked there.
  await app.newRepo.name.pressSequentially('tide tables');
  const where = app.main.locator('.nr-where');
  await expect(where).toHaveText('tide␣tables');
  await expect(where.locator('mark.bad-char')).toHaveText('␣');
  // Why it cannot be is said under the name, in the sheet, the sheet's top where it stood (a cell under the band).
  await expect(app.main.locator('.nr-box').getByRole('alert')).toHaveText('Use letters, digits, and . _ - (cannot start with .)');
  expect((await app.main.locator('.nr-box').boundingBox())!.y).toBe(72);
  expect((await app.main.locator('.nr-label').boundingBox())!.height).toBe(24);
  await app.newRepo.name.fill('tide');
  await expect(app.newRepo.problem).toBeHidden();
  await expect(where).toHaveText('tide');
  await expect(where.locator('mark')).toHaveCount(0);
});
