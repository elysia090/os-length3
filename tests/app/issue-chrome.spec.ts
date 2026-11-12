import {expect, test} from './fixtures.ts';

test('Issues keeps its band plain and its first action open, without changing Forge search', async ({signedIn: app}) => {
  await app.rail.go('git');
  await expect(app.main.locator('.search-in')).toHaveCount(0);
  await expect(app.main.locator('.pane-toggle')).toHaveCount(0);
  const first = app.main.locator('button.issue-new');
  await expect(first).toBeVisible();
  await expect(first).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  await first.click();
  await expect(app.page.getByRole('button', {name: 'Create', exact: true})).toBeVisible();
  await app.rail.go('forge');
  await expect(app.main.locator('.forge-first')).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  await expect(app.main.locator('.desk-bench .search-in')).toBeVisible();
  await expect(app.main.locator('.desk-bench .pane-toggle')).toBeAttached();
});

test('Issues reference readers still open and dismiss with focus returned to their origin', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.rail.go('git');
  const issueHead = app.main.locator('.pane-head').filter({hasText: /^Issue$/});
  const reader = app.main.locator('.plain-band .search-results');
  await issueHead.click();
  await expect(reader).toBeVisible();
  await expect(reader).toContainText('No issues yet');
  await expect(reader).toBeFocused();
  await reader.press('Escape');
  await expect(reader).toBeHidden();
  await expect(issueHead).toBeFocused();
  await issueHead.click();
  await expect(reader).toBeVisible();
  await app.rail.go('forge');
  await expect(reader).toBeHidden();
  await expect(app.main.locator('.desk-bench .search-in')).toBeVisible();
});


test('Issues keeps its reference reachable after Forge closes the shared pane', async ({signedIn: app}) => {
  await app.newRepo.make('hello');
  await app.newRepo.openInForge();
  await app.main.locator('.desk-bench .pane-toggle').click();
  await expect(app.main.locator('.desk-bench')).toHaveClass(/pane-closed/);
  await app.rail.go('git');
  const issues = app.main.locator('.plain-band');
  await expect(issues).not.toHaveClass(/pane-closed/);
  const head = issues.locator('.pane-head').filter({hasText: /^Issue$/});
  await head.click();
  await expect(issues.locator('.search-results')).toBeVisible();
  await issues.locator('.search-results').press('Escape');
  await expect(head).toBeFocused();
  await app.rail.go('forge');
  await expect(app.main.locator('.desk-bench')).toHaveClass(/pane-closed/);
});
