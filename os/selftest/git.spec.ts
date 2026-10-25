import {expect, test} from './fixtures.ts';

// Git: an issue written, started (it gets its own copy of the repo), the
// change made in Forge, then Commit, Push, Approve and Merge; merged, the
// issue is done and listed under Merged. What main itself has not committed
// is committed from main's card, named by its line. One that will not be
// done is closed and can be reopened; a reviewer can ask for changes.

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
  await expect(app.main.getByRole('region', {name: '1 file not committed'})).toContainText('HELLO.');
  await app.git.step('Commit').click();
  // Committed: Commit is done (no button), and Push is the next step.
  await expect(app.git.step('Commit')).toBeHidden();
  await expect(app.git.step('Push')).toBeEnabled();

  await app.git.step('Push').click();
  await expect(app.main.getByText('Change · version 1 · Undecided')).toBeVisible();
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

test('a change on main is committed from main\'s card, named by its line', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.newRepo.openInForge();
  await app.forge.editFile('README.md', '# hello\n\nOn main.\n');

  await app.rail.go('git');
  // A repo nobody has committed yet: the scaffold's README is not committed either.
  await expect(app.git.mainCard('hello').getByRole('region', {name: '1 file not committed'})).toBeVisible();
  // A line without a title is not a commit: said under it, the keyboard kept there.
  await app.git.commitOnMain('hello', 'Docs:');
  await expect(app.git.mainCard('hello').getByRole('alert')).toHaveText('A commit needs a title (for example Fix：title)');

  await app.git.mainCard('hello').getByRole('textbox').fill('Docs: Say where it runs');
  await app.git.commitLine('hello');
  await expect(app.git.mainCard('hello')).toBeHidden();
  await expect(app.git.committed('Say where it runs')).toBeVisible();

  // Committed, Forge's diff has nothing left against the last commit.
  await app.rail.go('forge');
  await app.forge.show('diff');
  await expect(app.forge.reference.getByText('README.md', {exact: true})).toBeHidden();
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

test('a reviewer asks for changes with a line marked, and the change waits for them', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.git.write('hello', 'Fix: Say hello louder');
  await expect(app.git.issue('#1 Fix：Say hello louder')).toBeVisible();
  await app.git.handIn({path: 'README.md', text: '# hello\n\nhello.\n'});

  // Asking says what: with nothing written or marked, it is asked for.
  await app.git.step('Ask for changes').click();
  await expect(app.git.review.getByRole('alert')).toHaveText('Say what to change, or mark its lines');

  const line = app.git.review.getByRole('button', {name: 'hello.', exact: true});
  await line.click();
  await expect(line).toHaveAttribute('aria-pressed', 'true');
  await app.git.review.getByRole('textbox', {name: 'Comment'}).fill('Louder, in capitals.');
  await app.git.step('Ask for changes').click();

  await expect(app.git.review.getByText('Asked for changes')).toBeVisible();
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

test('a new issue\'s repo is chosen in the one row above the box, Create at the left and Not now at the right', async ({app}) => {
  for (const r of ['notes', 'tide-tables', 'website-redesign', 'data-pipeline', 'design-system', 'infra-terraform']) await app.newRepo.make(r);
  await app.rail.go('git');
  await app.git.repos.getByRole('radio', {name: 'All', exact: true}).click();
  await app.main.getByRole('button', {name: 'Write an issue'}).click();
  // One row, outside the box: every chip on one line, however many there are; none inside the box.
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

  // Create first, then Not now; Not now makes nothing.
  const create = await app.git.step('Create').boundingBox();
  const notNow = await app.git.step('Not now').boundingBox();
  expect(create!.x).toBeLessThan(notNow!.x);
  await app.git.firstLine.fill('Fix: Not made');
  await app.git.step('Not now').click();
  await expect(app.git.issues).toContainText('No issues yet');

  await app.git.write('tide-tables', 'Fix: The table wraps', 'On a phone.');
  await expect(app.git.issue('#1 Fix：The table wraps')).toBeVisible();

  // Its detail is right under the title, above Commit: written there, and saved as it is left.
  const summary = app.main.getByRole('textbox', {name: 'Summary'});
  await expect(summary).toHaveValue('On a phone.');
  await expect(summary).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  await summary.fill('On a phone, at 320 px.');
  await summary.press('Tab');
  await app.page.reload();
  await app.settled();
  await app.rail.go('git');
  await expect(summary).toHaveValue('On a phone, at 320 px.');
});

test('a summary written and not left yet is kept through a reload, and saved then', async ({app}) => {
  await app.newRepo.make('tide-tables');
  await app.rail.go('git');
  await app.git.write('tide-tables', 'Fix: The table wraps', 'On a phone.');
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

test('the detail of a new issue has the room the repos inside the box had', async ({app}) => {
  await app.newRepo.make('notes');
  await app.rail.go('git');
  await app.main.getByRole('button', {name: 'Write an issue'}).click();
  // 96 px, and two rows of chips and the gap under them (32 + 8 + 32 + 12).
  expect((await app.main.getByRole('textbox', {name: 'Summary'}).boundingBox())!.height).toBeGreaterThanOrEqual(180);
});

test('an empty Issue view in Forge writes the first issue for its repo, and Not now goes back there', async ({app}) => {
  await app.newRepo.make('notes');
  // Git was last left on another repo: that is kept for Git, and is not where this one goes.
  await app.rail.go('git');
  await app.git.repos.getByRole('radio', {name: 'notes', exact: true}).click();
  await app.newRepo.make('tide');
  await app.newRepo.openInForge();
  await app.forge.show('Issue');
  await expect(app.forge.reference).toContainText('No issues yet');
  await app.forge.reference.getByRole('button', {name: 'Write an issue'}).click();

  await expect(app.rail.button('git')).toHaveAttribute('aria-current', 'page');
  await expect(app.git.firstLine).toBeFocused();
  await expect(app.git.firstLine).toHaveAccessibleDescription('tide');
  await expect(app.git.repos.getByRole('radio', {name: 'notes', exact: true})).toBeChecked();

  await app.git.step('Not now').click();
  await expect(app.rail.button('forge')).toHaveAttribute('aria-current', 'page');
  await expect(app.forge.editor('README.md')).toHaveValue('# tide\n');
  await app.forge.show('Issue');
  await expect(app.forge.reference).toContainText('No issues yet');
});

test('an issue\'s neighbours show their numbers at the edges that show, and the edges go to them', async ({app}) => {
  await app.newRepo.make('notes');
  for (const title of ['Fix: One', 'Feat: Two', 'Docs: Three']) await app.git.write('notes', title);
  await app.git.issues.getByRole('button', {name: 'Previous issue'}).click();
  await expect(app.git.issue('#2 Feat：Two')).toBeVisible();
  await expect(app.git.issue('#1')).toBeInViewport();
  await expect(app.git.issue('#3')).toBeInViewport();
  await app.git.issues.getByRole('button', {name: 'Next issue'}).click();
  await expect(app.git.issue('#3 Docs：Three')).toBeVisible();
  await expect(app.git.issue('#2')).toBeInViewport();
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
  await expect(app.main.getByRole('textbox', {name: 'Prompt box', exact: true})).toBeFocused();
  await expect(dock).toHaveCSS('opacity', '1');
  await app.page.keyboard.press('Escape');
  await expect(dock).toHaveCSS('opacity', '0');
});
