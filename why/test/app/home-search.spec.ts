import {expect, test} from './fixtures.ts';

test('Home Search keeps the centered input still while setting out its own results', async ({app}) => {
  const {page, forge} = app;
  await page.setViewportSize({width: 1536, height: 864});
  await app.newRepo.make('field-notes');
  await forge.editFile('README.md', '# Field notes\n\nKeep the first launch path short.\nWrite down launch timing.\n');
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
  await input.focus();

  const snippet = rows.first().locator('.sheet-text');
  const mono = await snippet.evaluate(el => getComputedStyle(el).fontFamily);
  expect(mono).not.toBe(sans);
  await expect(rows.first().locator('.sheet-line')).toHaveCSS('font-family', mono);
  await expect(result.getByRole('heading', {name: '2 matches', exact: true})).toHaveCSS('font-family', sans);
  await expect(rows.first().locator('.sheet-file')).toHaveCSS('font-family', sans);
  await expect(rows.first().locator('mark')).toHaveCSS('--marker', '#cea239');
  await expect(rows.first()).toHaveCSS('mix-blend-mode', 'normal');
  await input.press('ArrowDown');
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rows.last()).toBeFocused();
  await expect(rows.last()).toHaveCSS('outline-width', '2px');
  await expect(rows.last().locator('.sheet-line')).toHaveCSS('color', 'rgb(75, 72, 67)');

  // A file-name-only match uses the same face, even inside its highlighted match.
  await input.fill('README.md');
  const named = result.locator('.sheet-name .sheet-file');
  await expect(named).toHaveText('README.md');
  await expect(named).toHaveCSS('font-family', sans);
  await expect(named.locator('mark')).toHaveCSS('font-family', sans);

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

  // Forge still uses its original file and count faces.
  await app.rail.go('forge');
  await app.main.getByRole('button', {name: 'Search', exact: true}).click();
  await expect(stage).not.toHaveClass(/search-on-home/);
  await input.fill('launch');
  await expect(rows).toHaveCount(2);
  await expect(result.getByRole('heading', {name: '2 matches', exact: true})).toHaveCSS('font-family', mono);
  await expect(rows.first().locator('.sheet-file')).toHaveCSS('font-family', mono);
});
