import assert from 'node:assert/strict';
import {test} from 'node:test';
import {browserOnRemote} from './testing-remote.ts';

// A browser on one Remote, all in this process (testing-remote.ts): what the
// Git page asks the Remote for, as history.ts asks it.
const b = await browserOnRemote();
const {store, draft, history, asked} = b;

/** A repo of `n` files, committed and on the Remote. */
async function committed(repo: string, n: number) {
  await store.create(repo, '');
  for (let i = 0; i < n; i++) await store.add(repo, '', `f${i}.txt`, `${repo} ${i}\n`);
  await draft.sync(repo);
  await history.cut(repo, null, 'Fix：all of them', '');
}

/** While `f` runs, each request to /v1/blobs/ waits `ms`, as over a network; how many were asked at once, at most. */
async function slowBlobs<T>(ms: number, f: () => Promise<T>): Promise<{value: T; most: number}> {
  const real = globalThis.fetch;
  let now = 0, most = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (!new URL(url).pathname.startsWith('/v1/blobs/')) return real(url, init);
    now++; most = Math.max(most, now);
    try { await new Promise((r) => setTimeout(r, ms)); return await real(url, init); } finally { now--; }
  }) as typeof fetch;
  try { return {value: await f(), most}; } finally { globalThis.fetch = real; }
}

test('what is not committed is found without reading back from the Remote the files that did not change', async () => {
  await committed('many', 40);
  await store.write('many', 'f3.txt', 'file 3, changed\n');
  asked.length = 0;
  const c = await history.changes('many');
  assert.deepEqual([c.files, c.added, c.removed], [1, 1, 1]);
  // Before: every file at the last commit was fetched (40 blobs) to compare it with the one here, one after another.
  const blobs = asked.filter((p) => p.startsWith('/v1/blobs/')).length;
  assert.ok(blobs <= 1, `${blobs} blobs`);
});

test('a diff reads its files from the Remote several at a time, not one after another', async () => {
  await committed('wide', 12);
  for (let i = 0; i < 12; i++) await store.write('wide', `f${i}.txt`, `${i}, changed\n`);
  const {value: d, most} = await slowBlobs(20, () => history.diff('wide'));
  assert.equal(d.length, 12);
  assert.ok(d.every((f) => f.lines.some((l) => l.kind === 'add')));
  assert.ok(most > 1, `${most} at once`);
});
