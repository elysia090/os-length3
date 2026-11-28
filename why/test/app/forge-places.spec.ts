import {expect, test} from './fixtures.ts';

test('the empty desk has one real Open Folder chooser, from its action or desktop context', async ({app}) => {
  const {page, main} = app;
  await app.rail.go('forge');
  const first = main.getByRole('button', {name: 'Open Folder', exact: true});
  const choose = page.getByRole('dialog', {name: 'Open Folder', exact: true});
  const create = choose.getByRole('button', {name: 'Create your first repo', exact: true});
  await first.click();
  await expect(create).toBeVisible();
  await choose.getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(choose).toBeHidden();
  await expect(first).toBeFocused();

  await main.locator('.forge-empty').click({button: 'right', position: {x: 22, y: 72}});
  const start = page.getByRole('menu', {name: 'Workspace', exact: true});
  await start.getByRole('menuitem', {name: 'Open Folder', exact: true}).click();
  await expect(create).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(choose).toBeHidden();
  await expect(first).toBeFocused();

  await first.press('Shift+F10');
  await expect(start.getByRole('menuitem', {name: 'Open Folder', exact: true})).toBeFocused();
  await page.keyboard.press('Enter');
  await create.click();
  await expect(page.locator('#page')).toHaveAttribute('data-place', 'new-repo');
});

test('a managed folder is chosen by name; making one is not the action when folders exist', async ({app}) => {
  const {page, main} = app;
  await app.newRepo.make('cedar');
  await app.newRepo.make('pine');
  // Only forget which repo was in hand, not the files made through the ordinary entry above.
  await page.evaluate(() => localStorage.removeItem('why.os.repo'));
  await page.reload();
  // Forge is restored asynchronously after reload. Its empty desk is the entry, not the rail.
  await expect(page.locator('#page')).toHaveAttribute('data-place', 'forge');
  await main.getByRole('button', {name: 'Open Folder', exact: true}).click();
  const choose = page.getByRole('dialog', {name: 'Open Folder', exact: true});
  await expect(choose.getByRole('button', {name: 'cedar', exact: true})).toBeVisible();
  await expect(choose.getByRole('button', {name: 'Create your first repo', exact: true})).toHaveCount(0);
  await choose.getByRole('button', {name: 'pine', exact: true}).click();
  await expect(choose).toBeHidden();
  const tree = page.getByRole('tree', {name: 'pine', exact: true});
  await expect(tree.getByRole('button', {name: 'README.md', exact: true})).toBeVisible();
  await tree.getByRole('button', {name: 'README.md', exact: true}).click();
  await expect(app.forge.editor('README.md')).toHaveValue('# pine\n');
});

test('the corner switch shows the actual Prompt without moving the paper; document and file actions stay local', async ({app}) => {
  const {page, forge} = app;
  await page.setViewportSize({width: 1300, height: 900});
  await app.newRepo.make('pine');
  const editor = forge.editor('README.md');
  await expect(editor).toBeFocused();
  await editor.press('Control+Home');
  await editor.press('Shift+ArrowRight');
  // The retained textarea is deliberately outside the accessibility tree while Prompt is in hand.
  const retained = forge.piece('README.md').locator('textarea.code-edit');
  const position = () => retained.evaluate((area: HTMLTextAreaElement) => {
    const rect = area.getBoundingClientRect();
    return [rect.x, rect.y, area.selectionStart, area.selectionEnd, area.scrollTop, area.scrollLeft];
  });
  const before = await position();
  expect(await forge.selected('README.md')).toBe('#');
  await expect(page.getByRole('navigation', {name: 'Purposes', exact: true})).toBeHidden();
  await expect(forge.promptBox).toBeHidden();
  await forge.placesKey.click();
  await expect(forge.places.getByRole('menuitemradio')).toHaveText(['Home', 'Forge', 'Git', 'Server', 'Inbox', 'Runtime']);
  await page.keyboard.press('Escape');
  const tools = await forge.openTools();
  await expect(tools.getByRole('menuitem', {name: 'Prompt', exact: true})).toBeVisible();
  await expect(tools.getByRole('menuitem', {name: 'Files', exact: true})).toBeVisible();
  await forge.use('Prompt');
  const terminal = app.main.locator('.forge-prompt-slot');
  await expect(app.main).toHaveAccessibleName('Forge');
  await expect(terminal.getByRole('heading', {name: 'Prompt', exact: true})).toBeVisible();
  await expect(terminal.locator('.terminal-paper-head')).toHaveCSS('background-color', 'rgb(232, 228, 223)');
  await expect(terminal.locator('.terminal-paper-head')).toHaveCSS('background-image', 'none');
  await expect(terminal).toHaveCSS('border-top-left-radius', '3px');
  const band = terminal.locator('.terminal-paper-head');
  const [frameBox, bandBox] = await Promise.all([terminal.boundingBox(), band.boundingBox()]);
  const ruleY = Math.round(bandBox!.y + bandBox!.height - frameBox!.y) - 1;
  const screenshot = await terminal.screenshot({scale: 'css', animations: 'disabled', caret: 'hide'});
  const rim = await page.evaluate(async ({png, ruleY}) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), ch => ch.charCodeAt(0))], {type: 'image/png'}));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const rgb = (x: number, y: number) => Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3));
    return {
      head: rgb(0, ruleY - 1),
      rule: [0, Math.floor(bitmap.width / 2), bitmap.width - 1].map(x => rgb(x, ruleY)),
      body: [rgb(1, ruleY + 4), rgb(bitmap.width - 2, ruleY + 4), rgb(Math.floor(bitmap.width / 2), bitmap.height - 2)],
    };
  }, {png: screenshot.toString('base64'), ruleY});
  const near = (actual: number[], wanted: number[]) => {
    expect(Math.max(...actual.map((color, i) => Math.abs(color - wanted[i]!))),
      `rim: got ${actual}; expected ${wanted}; measured ${JSON.stringify(rim)}`).toBeLessThanOrEqual(1);
  };
  near(rim.head, [232, 228, 223]);
  for (const color of rim.rule) near(color, [104, 104, 104]);
  for (const color of rim.body) near(color, [140, 150, 148]);
  await expect(forge.promptBox).toBeFocused();
  await expect(editor).toBeHidden();
  await expect(retained).toHaveCount(1);
  await expect.poll(position).toEqual(before);
  await expect(terminal.locator('.terminal-paper-head > button')).toHaveCount(2);
  const rules = await terminal.locator('.terminal-paper-rule').evaluateAll(rs =>
    rs.map(r => getComputedStyle(r,'::before').backgroundImage));
  expect(rules).toHaveLength(2);
  expect(rules[0]).toEqual(rules[1]);
  await expect(terminal.getByRole('button', {name: 'Previous terminal'})).toBeDisabled();
  await terminal.getByRole('button', {name: 'Next terminal'}).click();
  await expect(terminal.getByRole('button', {name: 'Right terminal'})).toHaveAttribute('aria-current', 'true');
  await expect(forge.promptBox).toBeFocused();
  await terminal.getByRole('button', {name: 'Left terminal'}).press('Enter');
  await expect(terminal.getByRole('button', {name: 'Left terminal'})).toHaveAttribute('aria-current', 'true');
  await expect(forge.promptBox).toBeFocused();

  const context = page.locator('.forge-document-menu[role="menu"]');
  // The parked editor is not a second target while Prompt has the same bay.
  await expect(editor).toBeHidden();
  await terminal.locator('.desk-term:visible').click({button: 'right', position: {x: 160, y: 90}});
  await expect(context).toHaveCount(1);
  await expect(context).toHaveAttribute('aria-label', 'Terminal');
  await expect(context).not.toHaveAttribute('data-context', 'document');
  await expect(context.getByRole('menuitem')).toHaveText(['Close']);
  await context.getByRole('menuitem', {name: 'Close', exact: true}).click();
  await expect(context).toHaveCount(0);
  await expect(forge.promptBox).toBeHidden();
  await expect(editor).toBeFocused();
  await expect.poll(position).toEqual(before);
  await editor.press('Shift+F10');
  const menu = page.getByRole('menu', {name: 'Edit text', exact: true});
  await expect(menu.getByRole('menuitem', {name: 'Copy', exact: true})).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(editor).toBeFocused();
  await expect.poll(position).toEqual(before);

  // On a wide desk Files is already beside the paper. A held name opens a real contextual menu, not hover tools.
  await forge.use('Files');
  const row = page.getByRole('tree', {name: 'pine', exact: true}).getByRole('treeitem', {name: 'README.md', exact: true});
  const name = row.getByRole('button', {name: 'README.md', exact: true});
  const actions = page.getByRole('menu', {name: 'README.md', exact: true});
  const rename = row.getByRole('textbox', {name: 'New name', exact: true});
  await expect(name).toBeFocused();
  await name.hover();
  await expect(actions).toBeHidden();
  const start = (await name.locator('.file-shelf-primary').boundingBox())!.x;
  await name.click({button: 'right'});
  await actions.getByRole('menuitem', {name: 'Rename', exact: true}).click();
  await expect(rename).toBeFocused();
  await expect(rename).toHaveValue('README.md');
  expect(await rename.evaluate(input => input.getBoundingClientRect().x + parseFloat(getComputedStyle(input).paddingLeft))).toBe(start);
  expect(await rename.evaluate((n: HTMLInputElement) => n.value.slice(n.selectionStart!, n.selectionEnd!))).toBe('README');
  await rename.fill('Not kept.md');
  await page.keyboard.press('Escape');
  await expect(rename).toBeHidden();
  await expect(actions).toBeHidden();
  await expect(name).toBeFocused();

  await name.press('Shift+F10');
  await actions.getByRole('menuitem', {name: 'Rename', exact: true}).press('Enter');
  await expect(rename).toBeFocused();
  await expect(actions).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(rename).toBeHidden();
  await expect(name).toBeFocused();
});

test('an open Prompt stays open after returning to the same workspace', async ({app}) => {
  await app.newRepo.make('pine');
  const {forge} = app;
  const right = app.main.getByRole('button', {name: 'Right terminal', exact: true});
  await forge.openPrompt();
  await right.click();
  await expect(right).toHaveAttribute('aria-current', 'true');
  await forge.promptBox.fill('not sent');
  for (const place of ['home', 'git'] as const) {
    await app.rail.go(place);
    await expect(app.main.locator('.forge-prompt-slot')).toBeHidden();
    await app.rail.go('forge');
    await expect(forge.promptBox).toHaveValue('not sent');
    await expect(right).toHaveAttribute('aria-current', 'true');
  }
  // The actual Places command still toggles the companion both ways.
  await forge.use('Prompt');
  await expect(forge.promptBox).toBeHidden();
  await forge.openPrompt();
  await expect(forge.promptBox).toBeFocused();
  await expect(right).toHaveAttribute('aria-current', 'true');
});

test('on a narrow desk, selecting a real file shows the editor and hands it the keyboard', async ({app}) => {
  const {page, forge} = app;
  await page.setViewportSize({width: 390, height: 844});
  await app.newRepo.make('pine');
  const editor = forge.editor('README.md');
  await forge.use('Files');
  await expect(editor).toBeHidden();
  const tree = page.getByRole('tree', {name: 'pine', exact: true});
  await tree.getByRole('button', {name: 'README.md', exact: true}).click();
  await expect(tree).toBeHidden();
  await expect(editor).toBeVisible();
  await expect(editor).toBeFocused();
});

for (const width of [1440, 390]) {
  test.describe(`choosing an open document at ${width}px`, () => {
    const touch = width === 390;
    test.use({viewport: {width, height: 844}, hasTouch: touch, isMobile: touch, reducedMotion: 'reduce'});

    test('Files resumes an open document at its selection and scroll', async ({app}) => {
      const {page, forge} = app;
      await page.route('**/webroot/**', (route) => route.abort());
      await app.newRepo.make('pine');
      const text = Array.from({length: 96}, (_, n) => `Field note ${n + 1}: tide height in millimetres.`).join('\n');
      await forge.editFile('README.md', text);
      const editor = forge.editor('README.md');
      await expect(editor).toHaveValue(text);
      await editor.press('Control+End');
      await editor.press('Shift+ArrowLeft');
      await editor.press('Shift+ArrowLeft');
      const view = () => editor.evaluate((area: HTMLTextAreaElement) => {
        const port = area.closest<HTMLElement>('.desk-file')!;
        return {start: area.selectionStart, end: area.selectionEnd, direction: area.selectionDirection,
          left: area.scrollLeft, top: port.scrollTop};
      });
      await expect.poll(async () => (await view()).top).toBeGreaterThan(0);
      const before = await view();
      expect(before.start).toBe(text.length - 2);
      expect(before.end).toBe(text.length);
      expect(before.direction).toBe('backward');

      await forge.use('Files');
      const tree = page.getByRole('tree', {name: 'pine', exact: true});
      await expect(tree).toBeVisible();
      const same = tree.getByRole('button', {name: 'README.md', exact: true});
      if (touch) await same.tap(); else await same.click();
      await expect(editor).toBeFocused();
      await expect(editor).toHaveValue(text);
      await expect.poll(view).toEqual(before);
    });
  });
}

test.describe('Files rename on touch', () => {
  test.use({hasTouch: true, isMobile: true, viewport: {width: 390, height: 844}});

  test('the same name is edited from its row menu, and Enter leaves the keyboard on the renamed row', async ({app}) => {
    const {page, forge} = app;
    await app.newRepo.make('pine');
    await forge.use('Files');
    const tree = page.getByRole('tree', {name: 'pine', exact: true});
    const row = tree.getByRole('treeitem', {name: 'README.md', exact: true});
    const before = await row.getByRole('button', {name: 'README.md', exact: true}).boundingBox();
    await row.getByRole('button', {name: 'Actions for README.md', exact: true}).tap();
    const actions = page.getByRole('menu', {name: 'README.md', exact: true});
    await actions.getByRole('menuitem', {name: 'Rename', exact: true}).tap();

    const field = row.getByRole('textbox', {name: 'New name', exact: true});
    await expect(field).toBeFocused();
    expect(await field.boundingBox()).toEqual(before);
    await expect(actions).toBeHidden();
    await field.fill('Notes.md');
    await field.press('Enter');
    await expect(tree.getByRole('button', {name: 'Notes.md', exact: true})).toBeFocused();
    await expect(tree.getByRole('button', {name: 'README.md', exact: true})).toHaveCount(0);
    await expect(tree).toBeVisible();
  });
});
