import assert from 'node:assert/strict';
import {test} from 'node:test';
import {remote} from './harness.ts';

// l3 against a Remote that holds no files (service/dev.ts with LENGTH3_NO_BUCKET=1, as a
// Worker without R2): sign-in and Home's settings are the Remote's as ever;
// a repo's files stay on the device, l3 says why, and nothing is taken as
// agreed, so they go once the Remote can hold them.

const r = await remote({LENGTH3_NO_BUCKET: '1'});
const ren = await r.browser('Ren Bucketless');
const laptop = r.device();

test('with no files on the Remote, l3 signs in, keeps Home there, and keeps a repo here, saying why', async () => {
  assert.equal((await laptop.login(ren)).code, 0);
  const todo = laptop.l3(['todo', 'add', 'Kept there']);
  assert.equal(todo.code, 0, todo.err);
  assert.equal(todo.err, '');
  const remoteTodo = (await r.api(ren, 'GET', '/v1/home/todo')).json as {value: string; version: number};
  assert.match(remoteTodo.value, /Kept there/);

  const made = laptop.l3(['repo', 'new', 'kept', '-t', 'empty']);
  assert.equal(made.code, 0, made.err);
  assert.match(made.err, /kept is not sent yet: Remote cannot accept files right now; changes stay on this device; it goes after a later command/);
  const wrote = laptop.l3(['file', 'write', 'kept/notes.md'], 'here\n');
  assert.equal(wrote.code, 0, wrote.err);
  assert.match(wrote.err, /kept is not sent yet: Remote cannot accept files right now/);
  assert.equal(laptop.l3(['file', 'kept/notes.md']).out, 'here\n');
  // The Remote holds nothing of it, and the device has agreed nothing: it is all still to send.
  assert.equal((await r.api(ren, 'GET', '/v1/repos/kept')).status, 404);
});
