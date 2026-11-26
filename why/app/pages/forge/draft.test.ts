import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Draft} from './draft.ts';

function defer() {
  let open!: (ok?: boolean) => void;
  const when = new Promise<boolean>((resolve) => { open = (ok = true) => resolve(ok); });
  return {when, open};
}

test('timer, blur, and close join an in-flight write and wait for its newer draft', async () => {
  const gates = [defer(), defer()];
  const writes: string[] = [];
  let disk = 'initial';
  const draft = new Draft(disk, 1000, async (text) => {
    const at = writes.push(text) - 1;
    assert.ok(await gates[at].when);
    disk = text;
    draft.take(text); // Observed store publishes its own save as the write returns.
  });
  const first: string[] = [], second: string[] = [];
  draft.watch(() => first.push(draft.text));
  draft.watch(() => second.push(draft.text));
  draft.edit('first');
  const blur = draft.flush();
  await Promise.resolve();
  draft.edit('initial'); // Undo before the first acknowledged write.
  let closed = false;
  const close = draft.flush().then((ok) => { closed = ok; return ok; });
  assert.deepEqual(writes, ['first']);
  assert.equal(closed, false);
  assert.equal(draft.clean, false);
  gates[0].open();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(writes, ['first', 'initial']);
  assert.equal(closed, false);
  gates[1].open();
  assert.deepEqual(await Promise.all([blur, close]), [true, true]);
  assert.equal(disk, 'initial');
  assert.equal(draft.clean, true);
  assert.deepEqual(first, second);
  assert.equal(first.at(-1), disk);
  draft.stop();
});

test('a refused write leaves both views on the draft; only a subsequent explicit retry can close', async () => {
  let writes = 0, disk = 'saved';
  const draft = new Draft(disk, 1000, async (text) => {
    if (++writes === 1) throw Error('disk refused this write');
    disk = text;
  });
  draft.edit('unsaved');
  assert.deepEqual(await Promise.all([draft.flush(), draft.flush()]), [false, false]);
  assert.equal(writes, 1);
  assert.equal(draft.text, 'unsaved');
  assert.equal(disk, 'saved');
  assert.equal(draft.clean, false);
  assert.match(String(draft.error), /disk refused/);
  assert.equal(await draft.flush(), true);
  assert.equal(disk, 'unsaved');
  assert.equal(draft.failed, false);
  draft.stop();
});

test('an external edit never takes dirty text out of either view or counts as a local save', async () => {
  let writes = 0;
  const draft = new Draft('saved', 1000, async () => { writes++; });
  draft.edit('local');
  assert.equal(draft.take('external'), false);
  assert.equal(await draft.flush(), false);
  assert.equal(draft.text, 'local');
  assert.equal(draft.theirs, 'external');
  assert.equal(writes, 0);
  draft.useTheirs();
  assert.equal(draft.text, 'external');
  assert.equal(await draft.flush(), true);
  assert.equal(writes, 0);
  draft.stop();
});

test('too large must not silently save whole to close a view', async () => {
  const writes: [string, boolean][] = [];
  const draft = new Draft('', 4, async (text, whole) => { writes.push([text, whole]); });
  draft.edit('あいう');
  assert.equal(await draft.flush(), false);
  assert.deepEqual(writes, []);
  assert.equal(draft.text, 'あいう');
  assert.equal(await draft.flush(true), true);
  assert.deepEqual(writes, [['あいう', true]]);
  draft.stop();
});

test('an unreadable external replacement cannot be overwritten by blur or by closing', async () => {
  const writes: string[] = [];
  const draft = new Draft('old', 1000, async (text) => { writes.push(text); });
  draft.edit('local');
  draft.blockUnread();
  assert.equal(await draft.flush(), false);
  assert.equal(draft.text, 'local');
  assert.deepEqual(writes, []);
  draft.stop();
});
