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
    const paper = (await app.forge.results.boundingBox())!;
    const center = (await app.main.locator('.center').boundingBox())!;
    expect(paper.x).toBeGreaterThanOrEqual(center.x);
    expect(paper.x + paper.width).toBeLessThanOrEqual(center.x + center.width + 1);
    expect(paper.y + paper.height).toBeLessThan(900);
    // Two fixed sections and an intrinsic filename track used to leave snippets with zero width.
    const words = (await row.locator('.sheet-text').boundingBox())!;
    expect(words.width).toBeGreaterThan(100);
    expect(words.x).toBeGreaterThanOrEqual(paper.x);
    expect(words.x + words.width).toBeLessThanOrEqual(paper.x + paper.width);
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
