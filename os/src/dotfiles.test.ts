import assert from 'node:assert/strict';
import {test} from 'node:test';

// Home's storage as a browser keeps it: a map.
const shelf = new Map<string, string>();
Object.assign(globalThis, {localStorage: {
  getItem: (k: string) => shelf.get(k) ?? null, setItem: (k: string, v: string) => void shelf.set(k, v), removeItem: (k: string) => void shelf.delete(k),
}});
const dotfiles = await import('./dotfiles.ts');

test('saving keeps the others and is what the next Prompt starts with', async () => {
  await dotfiles.save('.profile', 'export A=1\n');
  await dotfiles.save('.gitconfig', '[user]\n');
  await dotfiles.save('.profile', 'export A=2\n');
  assert.deepEqual(dotfiles.read(), {'.gitconfig': '[user]\n', '.profile': 'export A=2\n'});
  assert.deepEqual(dotfiles.asFiles().map((f) => f.path).sort(), ['/root/.gitconfig', '/root/.profile']);
});

test('a name that is not a dotfile is refused and nothing is kept', async () => {
  const before = dotfiles.read();
  await assert.rejects(dotfiles.save('profile', 'x'), /dot first/);
  await assert.rejects(dotfiles.save('../.profile', 'x'), /dot first/);
  assert.deepEqual(dotfiles.read(), before);
});

test('removing takes only that one, and removing one not there changes nothing', async () => {
  await dotfiles.save('.inputrc', 'set bell-style none\n');
  await dotfiles.remove('.inputrc');
  assert.equal('.inputrc' in dotfiles.read(), false);
  assert.ok('.profile' in dotfiles.read());
  const before = dotfiles.read();
  await dotfiles.remove('.nothing');
  assert.deepEqual(dotfiles.read(), before);
});
