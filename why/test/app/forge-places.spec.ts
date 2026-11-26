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
  const position = () => editor.evaluate((area: HTMLTextAreaElement) => {
    const rect = area.getBoundingClientRect();
    return [rect.x, rect.y, area.selectionStart, area.selectionEnd, area.scrollTop, area.scrollLeft];
  });
  const before = await position();
  expect(await forge.selected('README.md')).toBe('#');
  await expect(page.getByRole('navigation', {name: 'Purposes', exact: true})).toBeHidden();
  await expect(forge.promptBox).toBeHidden();
  await forge.placesKey.click();
  await expect(forge.places.getByRole('menuitem', {name: 'Prompt', exact: true})).toBeVisible();
  await expect(forge.places.getByRole('menuitemradio')).toHaveText(['Forge', 'Files', 'Git']);
  await forge.use('Prompt');
  const terminal = app.main.locator('.forge-prompt-slot');
  await expect(app.main).toHaveAccessibleName('Forge');
  await expect(terminal.getByRole('heading', {name: 'Prompt', exact: true})).toBeVisible();
  await expect(terminal.locator('.terminal-paper-head')).toHaveCSS('background-color', 'rgb(231, 231, 231)');
  await expect(terminal.locator('.terminal-paper-head')).toHaveCSS('background-image', 'none');
  await expect(terminal).toHaveCSS('outline-color', 'rgb(36, 36, 36)');
  await expect(forge.promptBox).toBeFocused();
  await expect.poll(position).toEqual(before);
  await expect(terminal.getByRole('button', {name: 'Previous terminal'})).toBeDisabled();
  await terminal.getByRole('button', {name: 'Next terminal'}).click();
  await expect(terminal.getByRole('button', {name: 'Right terminal'})).toHaveAttribute('aria-pressed', 'true');
  await expect(forge.promptBox).toBeFocused();
  await terminal.getByRole('button', {name: 'Left terminal'}).press('Enter');
  await expect(terminal.getByRole('button', {name: 'Left terminal'})).toHaveAttribute('aria-pressed', 'true');
  await expect(forge.promptBox).toBeFocused();

  const context = page.locator('.forge-document-menu[role="menu"]');
  await editor.press('Shift+F10');
  await expect(context).toHaveCount(1);
  await expect(context).toHaveAttribute('aria-label', 'Edit text');
  await terminal.locator('.desk-term:visible').click({button: 'right', position: {x: 160, y: 90}});
  await expect(context).toHaveCount(1);
  await expect(context).toHaveAttribute('aria-label', 'Terminal');
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

  await forge.use('Files');
  const row = page.getByRole('tree', {name: 'pine', exact: true}).getByRole('treeitem', {name: 'README.md', exact: true});
  const name = row.getByRole('button', {name: 'README.md', exact: true});
  await expect(name).toBeVisible();
  await expect(row.getByRole('button', {name: 'Rename', exact: true})).toBeHidden();
  await name.hover();
  await expect(row.getByRole('button', {name: 'Rename', exact: true})).toBeVisible();
  await expect(row.getByRole('button', {name: 'Delete', exact: true})).toBeVisible();
  await row.getByRole('button', {name: 'Rename', exact: true}).click();
  const actions = page.getByRole('menu', {name: 'README.md', exact: true});
  const rename = actions.getByRole('textbox', {name: 'New name', exact: true});
  await expect(rename).toBeFocused();
  await expect(rename).toHaveValue('README.md');
  await page.keyboard.press('Escape');
  await expect(rename).toBeHidden();
  await expect(actions).toBeHidden();
  await expect(name).toBeFocused();
  await editor.hover();
  await expect(row.getByRole('button', {name: 'Rename', exact: true})).toBeHidden();

  await name.press('Shift+F10');
  const renameItem = actions.getByRole('menuitem', {name: 'Rename', exact: true});
  await expect(renameItem).toBeVisible();
  await renameItem.press('Enter');
  await expect(rename).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(rename).toBeHidden();
  await expect(renameItem).toBeFocused();
  await expect(actions).not.toHaveAttribute('aria-busy', 'true');
  await page.keyboard.press('Escape');
  await expect(actions).toBeHidden();
  await expect(name).toBeFocused();
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
