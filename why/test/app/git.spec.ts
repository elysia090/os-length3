import {expect, test} from './fixtures.ts';

// Git: an issue written, started (it gets its own copy of the repo), the
// change made in Forge, then Commit (it hands itself in), Approve and Merge; merged, the
// issue is done and listed under Merged. What main itself has not committed
// is committed from main's card, named by its line. One that will not be
// done is closed and can be reopened; a reviewer can ask for changes.

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
  // Committed, it is on one's own Remote, and on one's own repo that hands it in by itself: Commit is done (its mark,
  // no button), there is no Push (a push is to a server or another's Remote), the Submitted switch is on, and the
  // change waits for review, said by the Review under the box (not by a version beside the steps).
  await expect(app.git.step('Commit')).toBeHidden();
  // (The steps are the lines of main's sheet at the desk's edge: Start, Commit and Submit done, Merge the one next.)
  await expect(app.main.locator('.git-switch .switch-line.done')).toHaveCount(3);
  await expect(app.main.locator('.git-switch .switch-line.next')).toHaveText('Merge');
  await expect(app.main.locator('.git-switch')).not.toContainText('Push');
  await expect(app.main.locator('.git-switch')).not.toContainText('v1');
  const submitted = app.main.getByRole('switch', {name: 'Submitted'});
  await expect(submitted).toHaveAttribute('aria-checked', 'true');
  await expect(app.git.review).toBeVisible();
  // Switched off, the change is taken back; on again, the same commit is handed in anew, as the next version.
  await submitted.click();
  await expect(submitted).toHaveAttribute('aria-checked', 'false');
  await expect(app.git.review).toBeHidden();
  await submitted.click();
  await expect(submitted).toHaveAttribute('aria-checked', 'true');
  await expect(app.git.review).toBeVisible();
  await expect(app.git.review.getByText('HELLO.')).toBeVisible();

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
  // Worked on, #2 still has #1 beside it (it is main's, not left out of the work's copy), and #1 is closed from there.
  await app.git.step('Start').click();
  await expect(app.git.step('Back to main')).toBeVisible();
  await expect(app.git.issue('#1')).toBeInViewport();
  await app.git.issues.getByRole('button', {name: 'Previous issue'}).click();
  await expect(app.git.issue('#1 Fix：Say hello louder')).toBeVisible();
  await app.git.step('Close').click();
  await expect(app.git.section('Closed')).toContainText('#1 Fix：Say hello louder');
  await expect(app.git.issue('#2 Fix：Say it twice')).toBeVisible();
  await app.git.step('Back to main').click();
  await expect(app.git.step('Resume here')).toBeVisible();
});

test('a new issue\'s line is always there to be written, nothing to open or put back, and what is half written in it stays, the page left and come back to', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('git');
  await app.git.firstLine.fill('Fix: Say hello louder');
  // Nothing to press first, nothing to confirm or to put back.
  await expect(app.main.getByRole('button', {name: /^(Create|Create issue|Cancel|Save)$/})).toHaveCount(0);
  await app.rail.go('home');
  await app.rail.go('git');
  await expect(app.git.firstLine).toHaveValue('Fix: Say hello louder');
});

test('an issue that will not be done is closed, listed under Closed, and Reopen brings it back', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.git.write('hello', 'Idea: Say it in French');
  const issue = app.git.issue('#1 Idea：Say it in French');
  await expect(issue).toBeVisible();

  await app.git.step('Close').click();

  await expect(issue).toBeHidden();
  const closed = app.git.section('Closed');
  await expect(closed).toContainText('#1 Idea：Say it in French');
  await closed.getByRole('button', {name: 'Reopen #1'}).click();

  await expect(issue).toBeVisible();
  await expect(closed).toBeHidden();
  await expect(app.git.step('Start')).toBeVisible();
});

test('closed, the row goes on to the issue beside it, never to its Close; reopened, back to it', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  for (const [n, title] of [[1, 'Fix: Say hello louder'], [2, 'Idea: Say it in French'], [3, 'Docs: Say where it runs']] as const) {
    await app.git.write('hello', title);
    await expect(app.git.issue(`#${n} ${title.replace(': ', '：')}`)).toBeVisible();
  }
  await app.git.issues.getByRole('button', {name: 'Previous issue'}).click();
  await expect(app.git.issue('#2 Idea：Say it in French')).toBeVisible();

  await app.git.step('Close').focus();
  await app.page.keyboard.press('Enter');
  // The one after it, not the first of the row.
  await expect(app.git.issue('#3 Docs：Say where it runs')).toBeVisible();
  // The keyboard is on the row, not on #3's Close: a second Enter closes nothing more.
  await expect(app.git.step('Close')).not.toBeFocused();

  await app.git.section('Closed').getByRole('button', {name: 'Reopen #2'}).click();
  await expect(app.git.issue('#2 Idea：Say it in French')).toBeVisible();
});

test('a step under way keeps its word and its look, and says it is under way until it is done', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.git.write('hello', 'Fix: Say hello louder');
  const start = app.git.step('Start');
  await start.click();
  await expect(start).toHaveAttribute('aria-busy', 'true');
  await expect(start).toBeDisabled();
  await expect(start).toHaveCSS('opacity', '1');
  await expect(app.git.step('Back to main')).toBeVisible();
});

test('a started issue\'s deeds go down the sheet\'s left edge, on the line Start stood on', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.git.write('hello', 'Fix: Say hello louder');
  // Where Start stands once still: the sheet may still be coming in as it is first seen (a loaded machine is slower).
  let start = (await app.git.step('Start').boundingBox())!;
  await expect.poll(async () => {
    const was = start;
    start = (await app.git.step('Start').boundingBox())!;
    return Math.abs(start.x - was.x);
  }).toBeLessThan(0.5);
  await app.git.step('Start').click();
  await expect(app.git.step('Back to main')).toBeVisible();
  // Asked again until it holds: the sheet is drawn as Start is pressed and again as the repo's state comes, and a deed
  // measured as the first drawing is taken away has no box.
  for (const deed of ['Commit']) {
    await expect.poll(async () => {
      const b = await app.git.step(deed).boundingBox();
      return b ? Math.abs(b.x - start.x) : Infinity;
    // (The sheet lies square to the grid: its lines start on one edge.)
    }).toBeLessThan(1);
  }
});

test('a reload finds Git at the issue the repo\'s work is on', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.git.write('hello', 'Fix: One');
  await expect(app.git.issue('#1 Fix：One')).toBeVisible();
  await app.git.write('hello', 'Fix: Two');
  await expect(app.git.issue('#2 Fix：Two')).toBeVisible();
  await app.git.step('Start').click();
  await expect(app.git.step('Back to main')).toBeVisible();
  await app.page.reload();
  await app.settled();
  await app.rail.go('git');
  await expect(app.git.issue('#2 Fix：Two')).toBeVisible();
  await expect(app.git.step('Back to main')).toBeVisible();
});

test('a reviewer asks for changes with a line marked, and the change waits for them', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.git.write('hello', 'Fix: Say hello louder');
  await expect(app.git.issue('#1 Fix：Say hello louder')).toBeVisible();
  await app.git.handIn({path: 'README.md', text: '# hello\n\nhello.\n'});

  // Asking says what: with nothing written or marked, it is asked for.
  await app.git.step('Request changes').click();
  await expect(app.git.review.getByRole('alert')).toHaveText('Specify requested changes or select target lines');

  const line = app.git.review.getByRole('button', {name: 'hello.', exact: true});
  await line.click();
  await expect(line).toHaveAttribute('aria-pressed', 'true');
  await app.git.review.getByRole('textbox', {name: 'Comment'}).fill('Louder, in capitals.');
  await app.git.step('Request changes').click();

  await expect(app.git.review.locator('.review-chat').getByText('Changes requested')).toBeVisible();
  await expect(app.git.review.getByText('Louder, in capitals.')).toBeVisible();
  await expect(app.main.getByText('Not approved yet')).toBeVisible();
  await expect(app.git.step('Merge')).toBeDisabled();
});

test('a step pressed from the keyboard keeps the keyboard in the issues, never on the page body', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.git.write('hello', 'Fix: Say hello louder');
  await expect(app.git.issue('#1 Fix：Say hello louder')).toBeVisible();

  // Start is held while it runs and the box is drawn again after: the keyboard comes back into the issues.
  await app.git.step('Start').focus();
  await app.page.keyboard.press('Enter');
  await expect(app.git.step('Back to main')).toBeVisible();
  await expect.poll(() => app.page.evaluate(() => document.activeElement !== document.body && !!document.activeElement?.closest('main'))).toBe(true);
});

// The box an issue is written in, and the one row of repos above it.

test('a new issue\'s repo is chosen in the one row of repos; Enter on its line makes it, and the keyboard goes on into its summary', async ({app}) => {
  for (const r of ['notes', 'tide-tables', 'website-redesign', 'data-pipeline', 'design-system', 'infra-terraform']) await app.newRepo.make(r);
  await app.rail.go('git');
  await app.git.repos.getByRole('radio', {name: 'All', exact: true}).click();
  // One row: every chip on one line, however many there are.
  const tops = await app.git.repos.getByRole('radio').evaluateAll((all) => all.map((c) => Math.round(c.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  await expect(app.main.getByRole('radiogroup')).toHaveCount(1);
  // The one at the far end is reached by the keyboard, and, chosen, is where it goes; All leaves that as it was.
  const last = app.git.repos.getByRole('radio', {name: 'tide-tables', exact: true});
  await last.focus();
  await expect(last).toBeInViewport();
  await last.press('Enter');
  await expect(app.git.firstLine).toHaveAccessibleDescription('tide-tables');
  await app.git.repos.getByRole('radio', {name: 'All', exact: true}).click();
  await expect(app.git.firstLine).toHaveAccessibleDescription('tide-tables');

  // A line with no title makes nothing: said under it, the line kept.
  await app.git.firstLine.fill('Fix:');
  await app.git.firstLine.press('Enter');
  await expect(app.main.locator('.issues-new').getByRole('alert')).toHaveText('Enter a title on the first line');
  await expect(app.git.issues).toContainText('No issues yet');

  await app.git.firstLine.fill('Fix: The table wraps');
  await app.git.firstLine.press('Enter');
  await expect(app.git.issue('#1 Fix：The table wraps')).toBeVisible();
  await expect(app.git.firstLine).toHaveValue('');
  // Its detail is right under the title, above Commit: the keyboard there, written on, and kept as it is left.
  const summary = app.main.getByRole('textbox', {name: 'Summary', exact: true});
  await expect(summary).toBeFocused();
  await app.page.keyboard.insertText('At 320 px.');
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
  // Saved as it came back: kept by the repo, not only by the tab.
  await app.page.evaluate(() => sessionStorage.clear());
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



test('an empty Issue view in Forge writes the first issue for its repo, and Escape with nothing written goes back there', async ({app}) => {
  await app.newRepo.make('notes');
  await app.newRepo.make('scratch');
  // Git was last left on another repo: that is kept for Git, and is not where this one goes.
  // (The row of repos is on Git's band once there is more than one to choose from.)
  await app.rail.go('git');
  await app.git.repos.getByRole('radio', {name: 'notes', exact: true}).click();
  await app.newRepo.make('tide');
  await app.newRepo.openInForge();
  await app.forge.show('Issue');
  await expect(app.forge.reference).toContainText('No issues yet');
  await app.forge.reference.getByRole('button', {name: 'Create issue'}).click();

  await expect(app.page.locator('#page')).toHaveAttribute('data-place', 'git');
  await expect(app.rail.button('forge')).toHaveAttribute('aria-current', 'page');
  await expect(app.git.firstLine).toBeFocused();
  await expect(app.git.firstLine).toHaveAccessibleDescription('tide');
  await expect(app.git.repos.getByRole('radio', {name: 'notes', exact: true})).toBeChecked();

  // Nothing written, Escape goes back there.
  await app.page.keyboard.press('Escape');
  await expect(app.rail.button('forge')).toHaveAttribute('aria-current', 'page');
  await expect(app.forge.editor('README.md')).toHaveValue('# tide\n');
  await app.forge.show('Issue');
  await expect(app.forge.reference).toContainText('No issues yet');
});

test('an issue\'s neighbours show their numbers at the edges that show, and the edges go to them', async ({app}) => {
  await app.newRepo.make('notes');
  for (const title of ['Fix: One', 'Feat: Two', 'Docs: Three']) await app.git.write('notes', title);
  // The last one written is the one on screen (pressed while the box still moved to it, Previous went from #2).
  await expect(app.git.issue('#3 Docs：Three')).toBeVisible();
  await app.git.issues.getByRole('button', {name: 'Previous issue'}).click();
  await expect(app.git.issue('#2 Feat：Two')).toBeVisible();
  await expect(app.git.issue('#1')).toBeInViewport();
  await expect(app.git.issue('#3')).toBeInViewport();
  await app.git.issues.getByRole('button', {name: 'Next issue'}).click();
  await expect(app.git.issue('#3 Docs：Three')).toBeVisible();
  await expect(app.git.issue('#2')).toBeInViewport();
});

test('on a phone the issue in full takes the row, nothing in it wider than it, and a swipe goes along', async ({signedIn: app}) => {
  await app.page.setViewportSize({width: 390, height: 844});
  await app.newRepo.make('notes');
  for (const title of ['Fix: One', 'Feat: A second greeting for the evening', 'Docs: Three']) await app.git.write('notes', title);
  await expect(app.git.issue('#3 Docs：Three')).toBeVisible();
  await app.git.issues.getByRole('button', {name: 'Previous issue'}).click();
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
  // Not over the issue's buttons on arrival.
  const dock = app.main.locator('.dock:visible');
  await expect(dock).toHaveCSS('opacity', '0');
  await app.page.keyboard.press('Control+Backquote');
  await expect(app.main.getByRole('textbox', {name: 'Prompt input', exact: true})).toBeFocused();
  await expect(dock).toHaveCSS('opacity', '1');
  await app.page.keyboard.press('Escape');
  await expect(dock).toHaveCSS('opacity', '0');
});
