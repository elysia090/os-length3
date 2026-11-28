import {expect, test} from './fixtures.ts';

test('Home Search keeps the centered input still while setting out its own results', async ({app}) => {
  const {page, forge} = app;
  await page.setViewportSize({width: 1536, height: 864});
  await app.newRepo.make('field-notes');
  const long = 'handoff <task> "draft" ' + 'wide route '.repeat(14).trim();
  await forge.editFile('README.md', `# Field notes\n\nKeep the first launch path short.\nWrite down launch timing.\n${long}\n`);
  await app.rail.go('home');
  const home = page.locator('#page[data-place="home"]');
  const lens = home.getByRole('button', {name: 'Search', exact: true});
  const stage = page.getByRole('dialog', {name: 'Search', exact: true});
  const content = stage.locator('.search-screen-content'), group = stage.locator('.search-screen-paper');
  const title = stage.getByRole('heading', {name: 'Search', exact: true});
  const form = stage.getByRole('search'), input = stage.getByRole('searchbox');
  const result = stage.getByRole('region', {name: 'Search results'});
  const submit = form.getByRole('button', {name: 'Open first result'});
  const settledGeometry = () => Promise.all([title, form, input, submit].map(control => control.boundingBox()));
  const formPaint = () => form.evaluate(el => {
    const style = getComputedStyle(el);
    return [style.backgroundImage, style.backgroundSize, style.border, style.borderRadius];
  });

  await expect(lens).toBeVisible();
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await lens.press('Enter');
  await expect(input).toBeFocused();
  await expect(page.locator('.search-veil.out')).toHaveCount(0);
  await expect(home).toHaveCSS('visibility', 'hidden');
  await expect(home).toHaveAttribute('inert', '');
  await expect(content).toHaveCSS('animation-name', 'home-search-appear');
  await expect(content).toHaveCSS('transform', 'none');
  await content.evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));

  await expect(group).toHaveCSS('background-image', 'none');
  await expect(group).toHaveCSS('border-width', '0px');
  await expect(group).toHaveCSS('box-shadow', 'none');
  await expect(result).toHaveCount(0);
  const shadow = 'rgb(26, 29, 23)';
  const fullCast = `${shadow} 4px 4px 0px 0px`;
  await expect(form).toHaveCSS('box-shadow', fullCast);
  await expect(form).toHaveCSS('background-size', '4px 4px');
  const before = await settledGeometry(), paint = await formPaint();
  expect(before[1]).toEqual({x: 388, y: 290, width: 760, height: 50});
  expect(before[0]!.x + before[0]!.width / 2).toBe(768);
  const formFoot = before[1]!.y + before[1]!.height;

  const expectSplitPaper = async () => {
    await expect(result).toBeVisible();
    expect(await settledGeometry()).toEqual(before);
    expect(await formPaint()).toEqual(paint);
    expect((await result.boundingBox())!.y - formFoot).toBe(1.5);
    await expect(form).toHaveCSS('box-shadow', `${shadow} 4px 1.5px 0px 0px`);
    await expect(result).toHaveCSS('box-shadow', fullCast);
    await expect(result).toHaveCSS('border-top-width', '1px');
    await expect(result).toHaveCSS('border-radius', '8px');
    await expect(result).toHaveCSS('background-size', '4px 4px');
    await expect(result).toHaveCSS('background-image', /rgb\(209, 196, 166\).*rgb\(221, 209, 180\)/);
    expect(await group.evaluate(el => getComputedStyle(el, '::before').content)).toBe('none');
  };

  await input.click();
  const suggestions = result.getByRole('region', {name: 'Suggested files'});
  const suggested = suggestions.getByRole('button', {name: 'README.md', exact: true});
  await expect(suggested).toBeVisible();
  const sans = await input.evaluate(el => getComputedStyle(el).fontFamily);
  await expect(suggestions.getByRole('heading')).toHaveCSS('font-family', sans);
  const candidateHeading = (await suggestions.getByRole('heading').boundingBox())!;
  await expect(suggested).toHaveCSS('font-family', sans);
  await expectSplitPaper();
  await suggested.hover();
  await expect(suggested).toHaveCSS('background-image', /^conic-gradient\(/);
  await page.mouse.move(32, 160);
  await input.press('ArrowDown');
  await expect(suggested).toBeFocused();
  await expect(suggested).toHaveCSS('background-image', /^conic-gradient\(/);
  await suggested.press('Escape');
  await expect(result).toHaveCount(0);
  await expect(form).toHaveCSS('box-shadow', fullCast);
  expect(await settledGeometry()).toEqual(before);

  await input.fill('launch');
  const rows = result.getByRole('button', {name: /launch (path short|timing)/});
  await expect(rows).toHaveCount(2);
  await expectSplitPaper();

  const scope = stage.getByRole('combobox', {name: 'Search in', exact: true});
  await scope.click();
  await expect(scope.getByRole('option', {name: 'field-notes', exact: true})).toBeVisible();
  await expect(form).toHaveCSS('box-shadow', 'none');
  await expect(result).toHaveCSS('box-shadow', 'none');
  await page.keyboard.press('Escape');
  await expect(scope).toBeFocused();
  await expectSplitPaper();
  await rows.last().hover();
  await expect(rows.last()).toHaveCSS('--search-selection-share', '50%');
  await page.mouse.move(32, 160);
  await input.focus();

  const snippet = rows.first().locator('.sheet-text');
  const mono = await snippet.evaluate(el => getComputedStyle(el).fontFamily);
  expect(mono).not.toBe(sans);
  await expect(rows.first().locator('.sheet-line')).toHaveCSS('font-family', mono);
  await expect(rows.first().locator('.sheet-line')).toHaveCSS('scale', '0.86');
  const count = result.getByRole('heading', {name: '2 matches for "launch"', exact: true});
  await expect(count).toHaveCSS('font-family', sans);
  expect((await count.boundingBox())!.y).toBe(candidateHeading.y - 2);
  await expect(rows.first()).toHaveCSS('--search-selection-share', '57%');
  await rows.last().hover();
  const choicePaint = (row: typeof rows) => row.evaluate(el => ({
    fill: getComputedStyle(el).backgroundImage,
    blend: getComputedStyle(el).mixBlendMode,
    number: getComputedStyle(el.querySelector('.sheet-line')!).color,
    mark: getComputedStyle(el.querySelector('mark')!).backgroundImage,
    markBlend: getComputedStyle(el.querySelector('mark')!).mixBlendMode,
  }));
  const homeStock = await result.evaluate(el => getComputedStyle(el).backgroundImage);
  const homeActive = await choicePaint(rows.first()), homeHover = await choicePaint(rows.last());
  expect(homeActive.mark).toBe('linear-gradient(rgb(206, 162, 57), rgb(206, 162, 57))');
  expect(homeActive.markBlend).toBe('normal');
  await expect(rows.last()).toHaveCSS('--search-selection-share', '40%');
  await expect(rows.last()).toHaveCSS('background-image', /^conic-gradient\(/);
  await expect(result.locator('.search-screen-enter:visible')).toHaveCount(0);
  expect(await rows.first().evaluate(el => getComputedStyle(el).backgroundImage))
    .not.toBe(await rows.last().evaluate(el => getComputedStyle(el).backgroundImage));
  await page.mouse.move(32, 160);
  await expect(rows.first().locator('.sheet-file')).toHaveCSS('font-family', sans);
  await expect(rows.first().locator('mark')).toHaveCSS('--marker', '#cea239');
  await expect(rows.first()).toHaveCSS('mix-blend-mode', 'normal');
  await input.press('ArrowDown');
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rows.last()).toBeFocused();
  await expect(rows.last()).toHaveCSS('outline-width', '2px');
  const cue = rows.last().locator('.search-screen-enter');
  await expect(cue).toHaveText('↵');
  await expect(cue).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(cue).toHaveCSS('border-width', '0px');
  await expect(cue).toHaveAttribute('aria-hidden', 'true');
  await expect(cue).toBeVisible();
  await expect(result.locator('.search-screen-enter:visible')).toHaveCount(1);
  await rows.first().hover();
  await expect(rows.first()).toHaveCSS('--search-selection-share', '40%');
  await expect(rows.last()).toHaveCSS('--search-selection-share', '57%');
  await expect(cue).toBeVisible();
  await page.mouse.move(32, 160);
  await expect(rows.last().locator('.sheet-line')).toHaveCSS('color', 'rgb(74, 71, 66)');

  // A file-name-only match uses the same face, even inside its highlighted match.
  await input.fill('README.md');
  const named = result.locator('.sheet-name .sheet-file');
  await expect(named).toHaveText('README.md');
  await expect(named).toHaveCSS('font-family', sans);
  await expect(named.locator('mark')).toHaveCSS('font-family', sans);
  await expect(result.getByRole('heading', {name: '1 match for "README.md"', exact: true})).toBeVisible();

  // A long query is literal text, clipped visually only, with its full accessible name.
  await input.fill(long);
  const longCount = result.getByRole('heading', {name: `1 match for "${long}"`, exact: true});
  await expect(longCount).toBeVisible();
  await expect(longCount).toHaveCSS('white-space', 'nowrap');
  await expect(longCount).toHaveCSS('text-overflow', 'ellipsis');
  expect(await longCount.evaluate(el => el.scrollWidth)).toBeGreaterThan(await longCount.evaluate(el => el.clientWidth));
  await expect(longCount.locator('task')).toHaveCount(0);


  // Typing and confirming a line with Enter still opens the same anchored source and Back keeps the matches.
  await input.fill('launch');
  await expect(rows).toHaveCount(2);
  await input.press('ArrowDown');
  await expect(rows.first()).toBeFocused();
  await rows.first().press('Enter');
  await expect(stage).toHaveCount(0);
  await expect(forge.editor('README.md')).toBeFocused();
  const exact = forge.piece('README.md').locator('mark.desk-match');
  await expect(exact).toHaveText('launch');
  await expect(exact).toHaveAttribute('data-line', '3');
  await page.goBack();
  await expect(input).toHaveValue('launch');
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(stage).toHaveCount(0);
  await expect(home).toHaveCSS('visibility', 'visible');
  await expect(lens).toBeFocused();

  // Forge keeps the split surfaces and shared pigments, with its own stock.
  await app.rail.go('forge');
  await app.main.getByRole('button', {name: 'Search', exact: true}).click();
  await expect(stage).toHaveClass(/search-on-forge/);
  await expect(page.locator('.search-veil.out')).toBeVisible();
  await input.fill('launch');
  await expect(rows).toHaveCount(2);
  await expect(group).toHaveCSS('overflow', 'visible');
  await expect(form).toHaveCSS('box-shadow', `${shadow} 4px 1.5px 0px 0px`);
  await expect(result).toHaveCSS('box-shadow', fullCast);
  await rows.last().hover();
  await expect(result).toHaveCSS('background-image', /rgb\(216, 213, 206\).*rgb\(228, 225, 218\)/);
  expect(await result.evaluate(el => getComputedStyle(el).backgroundImage)).not.toBe(homeStock);
  await expect(rows.first()).toHaveCSS('--search-selection-share', '57%');
  await expect(rows.last()).toHaveCSS('--search-selection-share', '40%');
  for (const [row, homePaint] of [[rows.first(), homeActive], [rows.last(), homeHover]] as const) {
    await expect(row).toHaveCSS('--search-results-selection', '#afaba0');
    const paint = await choicePaint(row);
    expect(paint.fill).not.toBe(homePaint.fill); // The same mix takes on its new stock.
    expect({...paint, fill:homePaint.fill}).toEqual(homePaint);
  }
  await expect(result.getByRole('heading', {name: '2 matches for "launch"', exact: true})).toHaveCSS('font-family', sans);
  await expect(rows.first().locator('.sheet-file')).toHaveCSS('font-family', sans);
  await expect(result.locator('.search-screen-enter')).toHaveCount(2);
  await expect(result.locator('.search-screen-enter').first()).toBeHidden();
});
