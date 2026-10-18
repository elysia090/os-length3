import {expect, test} from './fixtures.ts';

// Git: an issue written, started (it gets its own copy of the repo), the
// change made in Forge, then Commit, Push, Approve and Merge; merged, the
// issue is done and leaves the issues not merged yet.

test('an issue goes from written to merged, and leaves the open issues', async ({signedIn: app}) => {
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
  await expect(app.main.getByText('Every issue is merged')).toBeVisible();
});
