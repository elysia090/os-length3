import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserOnRemote} from './testing-remote.ts';

// A browser on one Remote, all in this process (testing-remote.ts): what a
// page does by itself, as lifecycle.ts does it.
const b = await browserOnRemote();
const lifecycle = await import('./lifecycle.ts');
const todo = (title: string) => JSON.stringify([{id: 'a', title}]);

test('typing in Home\'s TODO agrees it with the Remote after a pause, one agreement at a time, and loses no keystroke', async () => {
  b.asked.length = 0;
  // Thirty keystrokes, each as begin()'s listener hears a setting set.
  for (let i = 1; i <= 30; i++) {
    await b.state.setState('todo', todo('x'.repeat(i)));
    lifecycle.homeChanged('todo');
  }
  assert.equal(lifecycle.homeUnsent('todo'), true);
  await lifecycle.settled();
  await lifecycle.settled();
  // Each keystroke used to begin its own read and write, side by side: 146 requests for these 30.
  const asked = b.asked.filter((p) => p === '/v1/home/todo').length;
  assert.ok(asked <= 6, `${asked} requests`);
  assert.equal((await b.remoteHome('todo')).value, todo('x'.repeat(30)));
  assert.equal(lifecycle.homeUnsent('todo'), false);
});

test('a TODO changed here and not agreed yet is known to be unsent, so leaving the page keeps it', async () => {
  await b.state.setState('todo', todo('just before closing'));
  lifecycle.homeChanged('todo');
  assert.equal(lifecycle.homeUnsent('todo'), true);
  await lifecycle.settled();
  assert.equal(lifecycle.homeUnsent('todo'), false);
  assert.equal((await b.remoteHome('todo')).value, todo('just before closing'));
});

test('a repo only on the Remote, brought twice at once, comes once and both askers have it', async () => {
  await b.elsewhere('trip', {'a.txt': 'a\n'});
  // Before: the second made the repo again beside the first and failed ("repo trip already exists").
  await Promise.all([lifecycle.bring('trip'), lifecycle.bring('trip')]);
  assert.equal(await b.text('trip', 'a.txt'), 'a\n');
  lifecycle.end();
});
