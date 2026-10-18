import {expect, test} from './fixtures.ts';

// Home's TODO: a first line named like an issue (Kind：title), Enter for the
// detail, Enter on an empty line for the next item; done strikes the first
// line through.

test('a TODO is written as Kind: title, Enter for its detail, and done strikes it', async ({app}) => {
  await app.rail.go('home');
  const item = app.home.items.first();

  await app.home.title(item).fill('Fix: The tent leaks');
  // "Fix：" is taken as its kind; the title is what follows.
  await expect(item).toContainText('Fix：');
  await expect(app.home.title(item)).toHaveValue('The tent leaks');
  await expect(app.home.todo).toContainText('1 of 1 left');

  await app.home.title(item).press('Enter');
  await expect(app.home.detail(item)).toBeFocused();
  await app.home.detail(item).pressSequentially('Seam by the door');
  // Enter on an empty line ends the item and starts the next.
  await app.home.detail(item).press('Enter');
  await app.home.detail(item).press('Enter');
  await expect(app.home.title(app.home.items.nth(1))).toBeFocused();
  await expect(app.home.detail(item)).toHaveValue('Seam by the door');

  await app.home.mark(item).click();
  await expect(app.home.mark(item)).toHaveAttribute('aria-pressed', 'true');
  await expect(app.home.title(item)).toHaveCSS('text-decoration-line', 'line-through');
  await expect(app.home.todo).toContainText('0 of 1 left');
});
