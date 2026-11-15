import {expect, test} from './fixtures.ts';

// New repo (+): a name, what it is for (into its README, under the title),
// and the one scaffold (a README and docs/; its issues' place is the OS's, made with the first), its file named in the box (nothing to choose); made,
// it is gone into in Forge, the caret in its README. A name taken is said under the name, with
// the keyboard back on it. What is written stays while other pages are seen.

test('with no repo at all, Forge and Git offer to make the first, and that is New repo', async ({app}) => {
  for (const place of ['forge', 'git'] as const) {
    await app.rail.go(place);
    const first = app.main.getByRole('button', {name: /^Create your first repo/});
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
  // The repo to be made and what will be in it, nothing else of the device's (no /root, no tide).
  await expect(card.locator('.tree-row')).toHaveText([/^harbour/, /^docs/, /^README\.md/]);
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
  // Left out: it goes from the card, and will not be made.
  await card.locator('li[data-path="notes"] > .tree-row').hover();
  await card.getByRole('button', {name: 'Leave out notes'}).click();
  await expect(card.locator('li[data-path="notes"]')).toHaveCount(0);
  await expect(card.locator('.tree-row')).toHaveText([/^harbour/, /^charts/, /^2031/, /^README\.md/, /^tides\.md/]);
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
    expect(await box.evaluate((e) => getComputedStyle(e).boxShadow)).toBe('rgb(23, 22, 20) 12px 12px 0px 0px');
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

test('nothing named yet, the new row is a quiet place for the name, and Create asks for one first', async ({app}) => {
  await app.rail.go('new-repo');
  // The field holds no example to be taken for a name; the row it would be is dashed, saying what goes there.
  await expect(app.newRepo.name).toHaveValue('');
  await expect(app.newRepo.name).not.toHaveAttribute('placeholder');
  const slot = app.main.locator('.tree-still .tree-new');
  await expect(slot).toHaveClass(/tree-unnamed/);
  await expect(slot.locator('.tree-name')).toHaveText('Name');
  await expect(app.newRepo.problem).toBeHidden();
  await app.newRepo.create.click();
  await expect(app.newRepo.problem).toHaveText('Please enter a name first');
  await expect(app.newRepo.name).toBeFocused();
  // Written, it is the repo to be made, filled as File fills it.
  await app.newRepo.name.pressSequentially('tide');
  await expect(app.newRepo.problem).toBeHidden();
  await expect(slot).not.toHaveClass(/tree-unnamed/);
  await expect(slot.locator('.tree-name')).toHaveText('tide');
});

test('a name already taken is said under the name, and the name keeps the keyboard', async ({signedIn: app}) => {
  await app.newRepo.make('notes');
  await app.rail.go('new-repo');
  await expect(app.newRepo.name).toHaveValue('');

  await app.newRepo.fill('notes');
  await expect(app.newRepo.problem).toHaveText('A repo named "notes" already exists');
  await expect(app.newRepo.name).toBeFocused();
  await expect(app.newRepo.name).toHaveValue('notes');
  // Typing in it again clears what was said.
  await app.newRepo.name.pressSequentially('-2');
  await expect(app.newRepo.problem).toBeHidden();
});
