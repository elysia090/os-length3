import {expect, test} from './fixtures.ts';

test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

for (const width of [390, 500, 760, 1024, 1400]) {
  test(`the search paper and its words stay readable at ${width}px`, async ({app}) => {
    await app.newRepo.openInForge();
    await app.forge.editFile('README.md', '# hello\n\nSearchable words remain readable on the paper.\n');
    await app.page.setViewportSize({width, height: 900});
    await app.forge.find('Searchable');
    const row = app.forge.hit(/Searchable words remain/);
    await expect(row).toBeVisible();
    // A pane's dropdown used to override the desk sheet's anchor on narrow screens, putting it behind the rail.
    // (Measured once the paper has come down and is drawn as it stays: on its way, or between two drawings, it is
    // not where it will be.)
    await expect(async () => {
      // (The sheets lie from the desk's edge, under the band's keys: past the rail, and no further than the page.)
      const paper = await app.forge.results.boundingBox(), center = await app.main.locator('.center').boundingBox();
      const words = await row.locator('.sheet-text').boundingBox(), keys = await app.main.locator('.band-tools').boundingBox();
      expect(paper && center && words && keys).toBeTruthy();
      // (From the desk's edge, where the band's door is: two cells in, past the rail.)
      expect(paper!.x).toBeGreaterThanOrEqual(47);
      expect(paper!.x).toBeLessThanOrEqual(keys!.x);
      expect(paper!.x + paper!.width).toBeLessThanOrEqual(center!.x + center!.width + 1);
      expect(paper!.y + paper!.height).toBeLessThan(900);
      // Two fixed sections and an intrinsic filename track used to leave snippets with zero width.
      expect(words!.width).toBeGreaterThan(100);
      expect(words!.x).toBeGreaterThanOrEqual(paper!.x);
      expect(words!.x + words!.width).toBeLessThanOrEqual(paper!.x + paper!.width);
    }).toPass();
    await app.forge.search.press('ArrowDown');
    await expect(row).toBeFocused();
    await app.page.keyboard.press('Enter');
    await expect(app.forge.editor('README.md')).toBeFocused();
    await expect(app.forge.results).toBeHidden();
    await app.page.keyboard.press('Escape');
    await app.page.keyboard.press('/');
    await expect(app.forge.search).toHaveValue('Searchable');
    await expect(row).toBeVisible();
    // Clearing and leaving restores the desk; returning must not leave the old sheet over it.
    await app.forge.search.press('Escape');
    await app.forge.search.press('Escape');
    await expect(app.forge.results).toBeHidden();
    await expect(app.main.locator('.desk-bench')).not.toHaveClass(/sheet-down/);
  });
}

for (const width of [500, 1400, 1900]) {
  test(`long paths and late matches remain readable with several search kinds at ${width}px`, async ({app}) => {
    await app.newRepo.openInForge();
    const path = 'searchable-' + 'long-file-name-'.repeat(7) + '.md';
    await app.forge.rename('README.md', path);
    const line = 'Context before the match. '.repeat(12) + 'searchable target at the end.';
    await app.forge.editFile(path, '\n'.repeat(122) + line + '\n');
    const box = app.forge.promptBox;
    await box.focus();
    await box.press('Alt+ArrowDown');
    await app.main.getByRole('menuitemradio', {name: /Create issue/}).click();
    await box.fill('Fix: searchable companion issue');
    await box.press('Control+Enter');
    await expect(app.main.locator('.box-said')).toHaveText('Created as #1 in hello');
    await app.page.setViewportSize({width, height: 900});
    await app.forge.find('searchable');
    // A matching issue shares the paper with Files rather than testing only its one-kind case.
    await expect(app.forge.results.locator('.found-sec')).toHaveCount(2);
    const row = app.forge.results.locator('.sheet-hit:not(.sheet-name)').filter({hasText: 'target at the end'});
    await expect(row.locator('.sheet-line')).toHaveText('123');
    // (The paper is drawn again as each kind's matches come: measured once it has come to rest, a row not there for a
    // moment between two drawings is not a row with no size.)
    await expect(async () => {
      const words = await row.locator('.sheet-text').boundingBox(), mark = await row.locator('.sheet-text mark').boundingBox();
      expect(words).not.toBeNull();
      expect(mark).not.toBeNull();
      expect(words!.width).toBeGreaterThan(100);
      // The highlighter deliberately bleeds 1px past its text (diff.css mark margin).
      expect(mark!.x).toBeGreaterThanOrEqual(words!.x - 1);
      expect(mark!.x + mark!.width).toBeLessThanOrEqual(words!.x + words!.width + 1);
      expect(mark!.y + mark!.height).toBeLessThanOrEqual(words!.y + words!.height + 1);
    }).toPass();
    await row.click();
    await expect(app.forge.editor(path)).toBeFocused();
    await expect.poll(() => app.forge.lineChosen(path)).toBe(line);
    await app.forge.find('not-present-in-any-file');
    await expect(app.forge.results).toContainText('No results found');
  });
}
