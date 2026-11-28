import {expect, test} from './fixtures.ts';

// Git: an issue written, started (it gets its own copy of the repo), the
// change made in Forge, then Commit, Submit, Approve and Merge; merged, the
// issue is done and listed under Merged. What main itself has not committed
// is committed from main's card, named by its line. One that will not be
// done is closed and can be reopened; a reviewer can comment with marked lines.

test("on an issue's work, Forge's files come at once however long the Remote takes to say how the work stands", async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.newRepo.make('basil');
  await app.git.write('hello', 'Fix: Say hello louder');
  await app.git.step('Start').click();
  await expect(app.git.step('Back to main')).toBeVisible();
  // How the work stands is the Remote's to say (its line, its changes): slow to answer, it holds up nothing read here.
  await app.page.context().route(/\/v1\/repos\/hello(\/changes|\?line=)/, async (route) => {
    await new Promise((r) => setTimeout(r, 5000));
    await route.continue();
  });
  await app.rail.go('forge');
  await expect(app.forge.editor('README.md')).toBeVisible({timeout: 3000});
});

test('an issue goes from written to merged, and is listed under Merged', async ({signedIn: app}) => {
  await app.newRepo.make('hello');

  await app.git.write('hello', 'Fix: Say hello louder');
  const issue = app.git.issue('#1 Fix：Say hello louder');
  await expect(issue).toBeVisible();

  await app.git.step('Start').click();
  await expect(app.git.step('Back to main')).toBeVisible();
  await expect(app.git.step('Commit')).toBeDisabled();

  // The work is done where files are written: in Forge, on the issue's own copy.
  await app.rail.go('forge');
  await app.forge.editFile('README.md', '# hello\n\nHELLO.\n');

  await app.rail.go('git');
  await expect(app.main.getByRole('region', {name: '1 uncommitted file'})).toContainText('HELLO.');
  await app.git.step('Commit').click();
  await expect(app.main.locator('.git-switch [data-step="commit"]')).toHaveClass(/done/);
  await expect(app.git.step('Commit')).toBeDisabled();
  await expect(app.main.locator('.git-switch .switch-line.done')).toHaveCount(2);
  await expect(app.main.locator('.git-switch .switch-line.next')).toHaveText('Submit');
  await expect(app.git.review).toBeHidden();
  await app.git.step('Submit').click();
  await expect(app.main.locator('.git-switch .switch-line.done')).toHaveCount(3);
  await expect(app.main.locator('.git-switch .switch-line.next')).toHaveText('Merge');
  await expect(app.git.review.getByText('HELLO.', {exact: true})).toBeVisible();
  await expect(app.main.getByRole('button', {name: 'Version 1', exact: true})).toBeVisible();
  await expect(app.main.getByRole('button', {name: 'Request changes', exact: true})).toHaveCount(0);

  await expect(app.git.step('Merge')).toBeDisabled();
  await app.git.review.getByRole('button', {name: 'Approve'}).click();
  await expect(app.main.getByText(/^Approved by /)).toBeVisible();

  await app.git.step('Merge').click();
  await expect(issue).toBeHidden();
  await expect(app.git.issues).toContainText('No open issues');
  // Done with, it is listed under Merged, its diff a press away.
  const merged = app.git.section('Merged').getByRole('group').filter({hasText: '#1 Fix：Say hello louder'});
  await expect(merged).toContainText('merged just now');
  await merged.getByText('#1 Fix：Say hello louder').click();
  await expect(merged.getByText('HELLO.')).toBeVisible();
});

test('every issue stays in the row while one is worked on', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.git.write('hello', 'Fix: Say hello louder', 'People at the back cannot hear it.');
  await expect(app.git.issue('#1 Fix：Say hello louder')).toBeVisible();
  await app.git.write('hello', 'Fix: Say it twice', 'Once is not enough.');
  await expect(app.git.issue('#2 Fix：Say it twice')).toBeVisible();
  // Worked on, #2 still has #1 in its row (it is main's, not left out of the work's copy): before it, on the row's
  // map, and gone to and closed from there.
  await app.git.step('Start').click();
  await expect(app.git.step('Back to main')).toBeVisible();
  await expect(app.git.bar(1)).toBeVisible();
  await app.git.bar(1).click();
  await expect(app.git.issue('#1 Fix：Say hello louder')).toBeVisible();
  await app.git.step('Close').click();
  await expect(app.git.section('Closed')).toContainText('#1 Fix：Say hello louder');
  await expect(app.git.issue('#2 Fix：Say it twice')).toBeVisible();
  await app.git.step('Back to main').click();
  await expect(app.git.step('Resume here')).toBeVisible();
});

test('with no issues the first paper is ready to write, and an unfinished issue stays across places', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('git');
  await expect(app.git.createIssue).toBeDisabled();
  await app.git.firstLine.fill('Fix: Say hello louder');
  await app.git.detailDraft.fill('People at the back cannot hear it.');
  await expect(app.git.createIssue).toBeEnabled();
  await expect(app.main.locator('.git-side .switch-line')).toHaveText(['Start', 'Commit', 'Submit', 'Merge']);
  await app.rail.go('home');
  await app.rail.go('git');
  await expect(app.git.firstLine).toHaveValue('Fix: Say hello louder');
  await expect(app.git.detailDraft).toHaveValue('People at the back cannot hear it.');
});

test('the named way to a new issue is outside the paper and Escape goes back to the same issue', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.git.write('hello', 'Fix: One');
  await app.git.write('hello', 'Fix: Two');
  await app.git.bar(1).click();
  await expect(app.git.issue('#1 Fix：One')).toBeVisible();
  await expect(app.main.locator('.git-side input, .git-side textarea')).toHaveCount(0);
  await expect.poll(() => app.git.newIssue.evaluate((b) => {
    const card = b.closest('.issue-column')!.querySelector('.issue-slot[aria-current=true] .issue-card')!;
    return b.getBoundingClientRect().bottom - card.getBoundingClientRect().top;
  })).toBeLessThanOrEqual(1);
  await app.git.newIssue.click();
  await expect(app.git.firstLine).toBeFocused();
  await expect(app.git.firstLine).toHaveAccessibleDescription('hello');
  await app.git.firstLine.fill('Fix: Three');
  await app.git.detailDraft.fill('In the same repo.');
  await app.page.keyboard.press('Escape');
  await expect(app.git.issue('#1 Fix：One')).toBeVisible();
  await expect(app.git.newIssue).toBeFocused();
  await expect(app.git.firstLine).toHaveCount(0);
  await app.git.newIssue.click();
  await expect(app.git.firstLine).toHaveValue('Fix: Three');
  await expect(app.git.detailDraft).toHaveValue('In the same repo.');
  await app.git.createIssue.click();
  await expect(app.git.issue('#3 Fix：Three')).toBeVisible();
  await expect(app.main.getByRole('textbox', {name: 'Summary', exact: true})).toHaveValue('In the same repo.');
  await expect(app.git.step('Start')).toBeEnabled();
  await expect(app.git.step('Back to main')).toHaveCount(0);
});

test('Git uses desk ink outside the issue and paper ink inside it, without recolouring Forge', async ({app}) => {
  await app.newRepo.make('hello');
  const body = app.page.locator('body');
  const forge = await body.evaluate((node) => getComputedStyle(node).backgroundColor);
  await app.rail.go('git');
  await expect(body).toHaveCSS('background-color', 'rgb(58, 61, 54)');
  await expect(app.main.getByRole('heading', {name: 'Git', exact: true, level: 1})).toHaveCSS('color', 'rgb(239, 235, 227)');
  const card = app.main.locator('.issue-slot[aria-current="true"] > .issue-card');
  await expect(card).toHaveCSS('background-color', 'rgb(239, 235, 227)');
  await expect(app.git.firstLine).toHaveCSS('color', 'rgb(23, 22, 21)');
  await app.git.firstLine.fill('Fix: Output');
  await app.git.firstLine.press('Enter');
  await expect(app.git.issue('#1 Fix：Output')).toBeVisible();
  await expect(app.git.newIssue).toHaveCSS('color', 'rgb(193, 190, 176)');

  await app.forge.placesKey.click();
  const menu = app.forge.places;
  // Places stays in desk ink, not on a second cream issue surface.
  await expect(menu).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(menu).toHaveCSS('color', 'rgb(239, 235, 227)');
  await expect(menu.getByRole('menuitemradio', {name: 'Forge', exact: true})).toHaveCSS('color', 'rgb(239, 235, 227)');
  await app.forge.use('Forge');
  await expect(app.forge.editor('README.md')).toBeVisible();
  await expect(body).toHaveCSS('background-color', forge);
  await expect(app.main).toHaveCSS('--git-paper-ink', '');
});

test('a draft belongs to its own folder; Enter creates explicitly and keeps its detail', async ({app}) => {
  for (const r of ['notes', 'tide-tables']) await app.newRepo.make(r);
  await app.rail.go('git');
  await app.git.folder('tide-tables');
  await app.git.toNew();
  await expect(app.git.firstLine).toHaveAccessibleDescription('tide-tables');
  await app.git.firstLine.fill('Fix: The table wraps');
  await app.git.detailDraft.fill('At 320 px.');

  await app.git.folder('notes');
  await app.git.toNew();
  await expect(app.git.firstLine).toHaveAccessibleDescription('notes');
  await expect(app.git.firstLine).toHaveValue('');
  await app.git.firstLine.fill('Fix:');
  await app.git.firstLine.press('Enter');
  await expect(app.main.locator('.issue-new-card').getByRole('alert')).toHaveText('Enter a title on the first line');
  await expect(app.git.issues).toContainText('No issues yet');

  await app.git.folder('tide-tables');
  await app.git.toNew();
  await expect(app.git.firstLine).toHaveValue('Fix: The table wraps');
  await expect(app.git.detailDraft).toHaveValue('At 320 px.');
  await app.git.firstLine.press('Enter');
  await expect(app.git.issue('#1 Fix：The table wraps')).toBeVisible();
  const summary = app.main.getByRole('textbox', {name: 'Summary', exact: true});
  await expect(summary).toBeFocused();
  await expect(summary).toHaveValue('At 320 px.');
});

test('a summary written and not left yet is kept through a reload, and saved then', async ({app}) => {
  await app.newRepo.make('tide-tables');
  await app.rail.go('git');
  await app.git.write('tide-tables', 'Fix: The table wraps', 'On a phone.');
  // Made: the issue's own box, not the form's field that had the same words a moment before.
  await expect(app.git.issue('#1 Fix：The table wraps')).toBeVisible();
  const summary = app.main.getByRole('textbox', {name: 'Summary'});
  await expect(summary).toHaveValue('On a phone.');
  // Still in the field (nothing has saved it) when the page goes.
  await summary.fill('On a phone, at 320 px.');
  await app.page.reload();
  await app.settled();
  await app.rail.go('git');
  await expect(summary).toHaveValue('On a phone, at 320 px.');
  // Seeing it restored proves only that the tab kept it. Its draft disappears after the repo acknowledges the save.
  await expect.poll(() => app.page.evaluate(() => sessionStorage.getItem('why.git.summaries'))).toBeNull();
  await app.page.reload();
  await app.settled();
  await app.rail.go('git');
  await expect(summary).toHaveValue('On a phone, at 320 px.');
});

test('a field drawn again under the keyboard keeps its caret and what was selected in it', async ({app}) => {
  await app.newRepo.make('tide-tables');
  await app.rail.go('git');
  await app.git.write('tide-tables', 'Fix: The table wraps', 'On a phone.');
  await expect(app.git.issue('#1 Fix：The table wraps')).toBeVisible();
  const summary = app.main.getByRole('textbox', {name: 'Summary'});
  await summary.click();
  await summary.press('Control+A');
  // Drawn again under it, as a draw that comes late is: the same field, anew, where the old one stood.
  await app.page.evaluate(() => {
    const old = document.querySelector<HTMLTextAreaElement>('textarea.issue-summary')!;
    const anew = old.cloneNode() as HTMLTextAreaElement;
    anew.value = old.value;
    old.replaceWith(anew);
  });
  await expect(summary).toBeFocused();
  await app.page.keyboard.insertText('At 320 px.');
  await expect(summary).toHaveValue('At 320 px.');
});

test('an issue is made from the keyboard alone: its line, Enter, its summary written and left; and its title is written over where it is read, Enter keeping it and Escape putting it back', async ({app}) => {
  await app.newRepo.make('notes');
  await app.rail.go('git');
  await app.git.firstLine.fill('Fix: Made from the keyboard');
  await app.git.firstLine.press('Enter');
  const detail = app.main.getByRole('textbox', {name: 'Summary', exact: true});
  await expect(detail).toBeFocused();
  await app.page.keyboard.type('Without the pointer.');
  await app.page.keyboard.press('Tab');
  await expect(app.git.issue('#1 Fix：Made from the keyboard')).toBeVisible();
  await app.rail.go('home');
  await app.rail.go('git');
  await expect(detail).toHaveValue('Without the pointer.');

  // Its title pressed: written over in its place, the kind kept and the title chosen; Enter keeps what is written.
  await app.git.issue('#1 Fix：Made from the keyboard').click();
  const title = app.main.locator('.issue-retitle');
  await expect(title).toBeFocused();
  await app.page.keyboard.type('Made and named again');
  await app.page.keyboard.press('Enter');
  await expect(app.git.issue('#1 Fix：Made and named again')).toBeVisible();
  // Nothing to save, nothing to confirm: no Save, no Cancel; the summary as it was.
  await expect(app.main.getByRole('button', {name: /^(Save|Cancel)$/})).toHaveCount(0);
  await expect(detail).toHaveValue('Without the pointer.');
  // Written over and Escape: back as it was.
  await app.git.issue('#1 Fix：Made and named again').click();
  await app.page.keyboard.type('Not this');
  await app.page.keyboard.press('Escape');
  await expect(app.git.issue('#1 Fix：Made and named again')).toBeVisible();
});

test('the issue in full stands at the row\'s edge with the next ahead of it, its number at the edge that shows; the ones before are on the row\'s map, and a bar goes to its issue', async ({app}) => {
  await app.newRepo.make('notes');
  for (const title of ['Fix: One', 'Feat: Two', 'Docs: Three']) await app.git.write('notes', title);
  // The last one written is the one on screen, at the row's edge: nothing behind it in sight (DESIGN §2, look room).
  await expect(app.git.issue('#3 Docs：Three')).toBeVisible();
  await expect(app.git.issue('#2')).not.toBeInViewport();
  // The ones before are on the map, a bar each, the one in full in ink.
  await expect(app.git.bar(3)).toHaveAttribute('aria-current', 'true');
  await app.git.bar(2).click();
  await expect(app.git.issue('#2 Feat：Two')).toBeVisible();
  // (Read again till it holds: the row drawn again just after the press puts a new card where the one found was.)
  await expect.poll(async () => {
    const edge = await app.git.issue('#2 Feat：Two').evaluate((h) => h.isConnected ? h.closest('.issue-card')!.getBoundingClientRect().left : NaN);
    const row = await app.git.issues.locator('.issue-stage').evaluate((e) => e.getBoundingClientRect().left);
    return Math.abs(edge - row);
  }, {message: 'the issue in full at the row\'s edge'}).toBeLessThan(1);
  // Ahead of it, the next, its number in sight; behind it, nothing.
  await expect(app.git.issue('#3')).toBeInViewport();
  await expect(app.git.issue('#1')).not.toBeInViewport();
  await app.git.issues.getByRole('button', {name: 'Next issue'}).click();
  await expect(app.git.issue('#3 Docs：Three')).toBeVisible();
  // ← goes back along the row as the map does.
  await app.git.issues.locator('.issue-stage').focus();
  await app.page.keyboard.press('ArrowLeft');
  await expect(app.git.issue('#2 Feat：Two')).toBeVisible();
});

test('on a phone the issue in full takes the row, nothing in it wider than it, and a swipe goes along', async ({signedIn: app}) => {
  await app.page.setViewportSize({width: 390, height: 844});
  await app.newRepo.make('notes');
  for (const title of ['Fix: One', 'Feat: A second greeting for the evening', 'Docs: Three']) await app.git.write('notes', title);
  await expect(app.git.issue('#3 Docs：Three')).toBeVisible();
  await app.git.bar(2).click();
  const head = app.git.issue('#2 Feat：A second greeting for the evening');
  await expect(head).toBeVisible();
  // Its own deeds, measured with it at the same moment (the row may still be sliding to it, the one left giving its
  // deeds up as this one is drawn with them).
  await expect.poll(() => head.evaluate((e, deeds) => {
    const card = e.closest('.issue-card')!, edge = card.getBoundingClientRect().right;
    return deeds.every((d) => [...card.querySelectorAll('button')].some((b) => b.textContent === d && b.getBoundingClientRect().right <= edge + .5));
  }, ['Close'])).toBe(true);
  // (Its steps are main's sheet's lines, over the row on a phone, none wider than the window.)
  const start = (await app.git.step('Start').boundingBox())!;
  expect(start.x).toBeGreaterThanOrEqual(0);
  expect(start.x + start.width).toBeLessThanOrEqual(390);
  // A finger swiped to the left goes to the next issue, as its edge does.
  await app.git.issues.evaluate((section) => {
    const stage = section.querySelector('[aria-roledescription="carousel"]')!;
    const at = stage.getBoundingClientRect(), y = at.top + 60;
    const go = (type: string, x: number) => stage.dispatchEvent(new PointerEvent(type, {pointerType: 'touch', pointerId: 7, clientX: x, clientY: y, bubbles: true}));
    go('pointerdown', at.left + 220);
    go('pointerup', at.left + 80);
  });
  await expect(app.git.issue('#3 Docs：Three')).toBeVisible();
});

test('Git\'s column keeps its width whether it scrolls or not', async ({app}) => {
  await app.rail.go('git');
  // The room a scrollbar takes is kept while there is none, so reading and changing an issue's words never moves its edge.
  expect(await app.main.getByRole('region', {name: 'Git', exact: true}).evaluate((e) => getComputedStyle(e).scrollbarGutter)).toBe('stable');
});

test('Git is read and pressed: its box at the foot stands back until asked for, and back again once done with', async ({app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('git');
  const input = app.main.getByRole('textbox', {name: 'Prompt input', exact: true});
  // The desk first binds the available repo. Before that, the same shortcut has no target.
  await expect(input).toBeEnabled();
  // Not over the issue's buttons on arrival.
  const dock = app.main.locator('.dock:visible');
  await expect(dock).toHaveCSS('opacity', '0');
  await app.page.keyboard.press('Control+Backquote');
  await expect(input).toBeFocused();
  await expect(dock).toHaveCSS('opacity', '1');
  await app.page.keyboard.press('Escape');
  await expect(dock).toHaveCSS('opacity', '0');
});

test('main\'s four steps are gone along by ↑ and ↓, and Enter takes the one the keyboard is on at once, the page where it was; one not to be taken now says no where it is', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.git.write('hello', 'Fix: Say hello louder');
  const steps = app.main.locator('.git-switch [data-step] > button');
  await expect(steps).toHaveText(['Start', 'Commit', 'Submit', 'Merge']);
  await steps.first().focus();
  await app.page.keyboard.press('ArrowDown');
  await expect(steps.nth(1)).toBeFocused();
  await app.page.keyboard.press('End');
  await expect(steps.nth(3)).toBeFocused();
  // Merge cannot be taken yet: pressed, it is answered where it is, and nothing else happens.
  await expect(steps.nth(3)).toBeDisabled();
  await app.page.keyboard.press('Enter');
  await expect(steps.nth(3)).toBeFocused();
  await expect(app.main.locator('.git-switch .switch-line.next')).toHaveText('Start');
  await app.page.keyboard.press('Home');
  await expect(steps.first()).toBeFocused();
  const at = () => app.page.evaluate(() => [scrollY, document.querySelector('.page')?.scrollTop ?? 0]);
  const before = await at();
  await app.page.keyboard.press('Enter');
  await expect(app.main.locator('.git-switch .switch-line.next')).toHaveText('Commit');
  // Drawn again, the keyboard is on the same line and the page has not moved.
  await expect(app.main.locator('.git-switch [data-step="start"] > button')).toBeFocused();
  expect(await at()).toEqual(before);
});
