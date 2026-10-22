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
  await expect(app.main.getByText('1 file not committed')).toBeVisible();
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
  // A repo nobody has committed yet: the scaffold's three files are not committed either.
  await expect(app.git.mainCard('hello')).toContainText('3 files not committed');
  // A line without a title is not a commit: said under it, the keyboard kept there.
  await app.git.commitOnMain('hello', 'Docs:');
  await expect(app.git.mainCard('hello').getByRole('alert')).toHaveText('A commit needs a title (for example Fix：title)');

  await app.git.mainCard('hello').getByRole('textbox').fill('Docs: Say where it runs');
  await app.git.commitLine('hello');
  await expect(app.git.section('main')).toBeHidden();

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
