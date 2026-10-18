import {expect, test} from './fixtures.ts';

// Runtime: dotfiles are small cards (name, size); a dotfile saved is one,
// opens with its text, and is still there when the app is opened again.
// Remove asks in the box first, since it goes from every device.

test('a dotfile saved shows as a card, opens with its text, and stays', async ({app}) => {
  await app.runtime.makeDotfile('.profile', 'export EDITOR=vi\n');

  await expect(app.runtime.dotfile('.profile')).toContainText('17 B');

  await app.open();
  await app.rail.go('runtime');
  await app.runtime.dotfile('.profile').click();
  await expect(app.runtime.text('.profile')).toHaveValue('export EDITOR=vi\n');
});

test('removing a dotfile asks in its box: Not now keeps it, Remove takes it', async ({app}) => {
  await app.runtime.makeDotfile('.profile', 'export EDITOR=vi\n');
  await app.runtime.dotfile('.profile').click();

  const ask = await app.runtime.askRemove('.profile');
  await expect(ask).toContainText('.profile goes from every device.');
  await ask.getByRole('button', {name: 'Not now'}).click();
  await expect(ask).toBeHidden();
  await expect(app.runtime.text('.profile')).toHaveValue('export EDITOR=vi\n');

  const again = await app.runtime.askRemove('.profile');
  await app.answer(again.getByRole('button', {name: 'Remove', exact: true}), again);
  await expect(app.runtime.dotfile('.profile')).toHaveCount(0);

  await app.open();
  await app.rail.go('runtime');
  await expect(app.runtime.dotfiles).toBeVisible();
  await expect(app.runtime.dotfile('.profile')).toHaveCount(0);
});

test('a dotfile with a name that is not one is not saved, and says why', async ({app}) => {
  await app.runtime.makeDotfile('no-dot', 'x\n');

  await expect(app.runtime.dotfiles.getByRole('alert')).toHaveText('A dotfile is named with a dot first: .profile');
  await expect(app.runtime.dotfile('no-dot')).toHaveCount(0);
});
