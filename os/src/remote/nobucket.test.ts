import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserOnRemote} from '../testing/remote.ts';

// A browser on a Remote that holds no files (service/bucket.ts): what it
// cannot send stays here, nothing is taken as agreed, and why is said.
const b = await browserOnRemote({bucket: false});
const {store, draft, text} = b;

test('with no files on the Remote, a repo stays here as it is, not agreed, and the reason is said', async () => {
  await store.create('kept', 'standard');
  const before = await b.files('kept');
  assert.ok(Object.keys(before).length > 0);
  await assert.rejects(draft.sync('kept'), /The Remote cannot hold files just now; your work stays on this device/);
  // Every file is here as it was, and nothing was agreed: the next sync sends it all.
  assert.deepEqual(await b.files('kept'), before);
  const [s] = (await draft.status()).filter((x) => x.name === 'kept');
  assert.ok(s.fresh && s.changed >= Object.keys(before).length, JSON.stringify(s));
  // Rows still go: Home's settings are kept on the Remote all the same.
  await b.state.setState('todo', '[]');
  await draft.syncHome('todo');
  assert.deepEqual(await b.remoteHome('todo'), {value: '[]', version: 1});
  assert.ok(typeof await text('kept', Object.keys(before)[0]) === 'string');
});
