import {expect, test} from './fixtures.ts';

// Runtime: dotfiles are small cards (name, size); a dotfile saved is one,
// opens with its text, and is still there when the app is opened again.

test('a dotfile saved shows as a card, opens with its text, and stays', async ({app}) => {
  await app.runtime.makeDotfile('.profile', 'export EDITOR=vi\n');

  await expect(app.runtime.dotfile('.profile')).toContainText('17 B');

  await app.open();
  await app.rail.go('runtime');
  await app.runtime.dotfile('.profile').click();
  await expect(app.runtime.text('.profile')).toHaveValue('export EDITOR=vi\n');
});
