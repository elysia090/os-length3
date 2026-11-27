import {expect, test} from './fixtures.ts';

test.use({viewport: {width: 320, height: 640}, isMobile: true, hasTouch: true, deviceScaleFactor: 1});

test('the issue and review keys fit their paper at phone widths without widening the diff or the page', async ({signedIn: app}) => {
  const {page, git, forge, main} = app;
  const title = 'Keep revised tables legible';
  await app.newRepo.make('tide-tables');
  await git.write('tide-tables', `Fix: ${title}`, 'A three-file change, read at phone width.');
  await git.step('Start').tap();
  await expect(git.step('Back to main')).toBeVisible();
  await app.rail.go('forge');
  await app.file.named('tide-tables', '', 'New file', 'Makefile');
  await app.file.named('tide-tables', '', 'New folder', 'src');
  await app.file.named('tide-tables', 'src', 'New file', 'main.c');
  await forge.editFile('Makefile', 'all:\n\techo local\n');
  await forge.editFile('README.md', '# Tide tables\n\nPhone notes.\n');
  const rows = Array.from({length: 30}, (_, n) => `    // ${n + 1}: ${'a longer value '.repeat(12)}`).join('\n');
  await forge.editFile('src/main.c', `int main(void) {\n${rows}\n    return 0;\n}\n`);
  await app.rail.go('git');
  await expect(main.getByRole('region', {name: '3 uncommitted files', exact: true})).toBeVisible();
  await git.step('Commit').tap();
  await expect(git.step('Commit')).toBeDisabled();
  await git.step('Submit').tap();
  await expect(main.getByRole('button', {name: 'Version 1', exact: true})).toBeVisible();

  const paper = main.locator('.issue-slot[aria-current="true"] .git-paper');
  const heading = git.issue(`#1 Fix：${title}`);
  const comment = paper.getByRole('button', {name: 'Comment', exact: true});
  const approve = paper.getByRole('button', {name: 'Approve', exact: true});
  const diff = paper.getByRole('region', {name: 'Diff', exact: true});
  await expect(heading).toBeVisible();
  await expect(approve).toBeEnabled();
  await expect(diff.locator('.git-diff-name')).toHaveText(['Makefile', 'README.md', 'src/main.c']);

  for (const width of [320, 390]) {
    await test.step(`on a ${width}px paper`, async () => {
      if (width === 390) await page.setViewportSize({width, height: 844});
      // At a new width wait for the camera to lay its paper at the new measure.
      await expect(async () => {
        const box = await paper.evaluate(el => {
          const at = (selector?: string) => {
            const {left, right, top, bottom, width, height} = (selector ? el.querySelector(selector)! : el).getBoundingClientRect();
            return {left, right, top, bottom, width, height};
          };
          return {
            paper: at(),
            words: at('.issue-words'), title: at('h2'), foot: at('.git-paper-review'),
            comment: at('.git-review-comment'), approve: at('.git-review-approve'), diff: at('.git-diff-scroll'),
            pageWidth: document.scrollingElement!.scrollWidth,
          };
        });
        expect(box.pageWidth).toBe(width);
        expect(box.title.width).toBeCloseTo(box.words.width);
        expect(box.title.left).toBeCloseTo(box.words.left);
        expect(box.foot.top).toBeGreaterThanOrEqual(box.diff.bottom);
        expect(box.foot.left).toBeGreaterThanOrEqual(box.paper.left);
        expect(box.foot.right).toBeLessThanOrEqual(box.paper.right);
        for (const key of [box.comment, box.approve]) {
          expect(key.left).toBeGreaterThanOrEqual(box.foot.left);
          expect(key.right).toBeLessThanOrEqual(box.foot.right);
          expect(key.height).toBeGreaterThanOrEqual(36);
        }
        if (width === 320) {
          expect(box.approve.top).toBeGreaterThanOrEqual(box.comment.bottom);
          expect(box.approve.left).toBeCloseTo(box.comment.left);
        } else expect(box.approve.top).toBeCloseTo(box.comment.top);
      }).toPass({timeout: 5000});
    });
  }

  await page.setViewportSize({width: 320, height: 640});
  await diff.evaluate(el => { el.scrollLeft = 80; el.scrollTop = 110; });
  expect(await diff.evaluate(el => [el.scrollLeft, el.scrollTop])).toEqual([80, 110]);
  await diff.evaluate(el => { el.scrollLeft = 0; el.scrollTop = 0; });
  for (const name of ['Makefile', 'README.md']) {
    const file = diff.getByRole('button', {name, exact: true});
    await file.tap();
    await expect(file).toHaveAttribute('aria-expanded', 'false');
  }
  const line = diff.getByRole('button', {name: 'After: line 2 in src/main.c', exact: true});
  await line.tap();
  await expect(line).toHaveAttribute('aria-pressed', 'true');
  await comment.tap(); // Opens the real composer, without sending a comment or approving.
  const composer = main.getByRole('textbox', {name: 'Comment', exact: true});
  await expect(composer).toBeFocused();
  await composer.press('Escape');
  await expect(composer).toBeHidden();
  await expect(comment).toBeFocused();
  await expect(line).toHaveAttribute('aria-pressed', 'true');
});
