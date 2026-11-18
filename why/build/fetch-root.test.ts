import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {test} from 'node:test';

// Exercise the production download loop without fetching the large pinned root.
const source = readFileSync(new URL('./fetch-root.ts', import.meta.url), 'utf8');
const begin = source.indexOf('async function download(');
const code = stripTypeScriptTypes(source.slice(begin, source.indexOf('\nconst bytes = ', begin)));
function downloader(fetch: typeof globalThis.fetch) {
  const delays: number[] = [];
  const download = new Function('fetch', 'Buffer', 'setTimeout', 'console', `${code}; return download;`)(
    fetch, Buffer, (done: () => void, ms: number) => { delays.push(ms); done(); }, {error() {}},
  ) as (url: string, what: string) => Promise<Buffer>;
  return {download, delays};
}

test('root download retries a body cut after HTTP 200, returning only the complete retry', async () => {
  let attempts = 0;
  const {download, delays} = downloader(async () => {
    if (++attempts > 1) return new Response('complete');
    return new Response(new ReadableStream({start(c) { c.enqueue(new Uint8Array([1])); c.error(new Error('body cut')); }}));
  });
  assert.equal((await download('https://test/root', 'root')).toString(), 'complete');
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [4000]);
});

test('root download releases 5xx bodies before retry; 4xx is final', async () => {
  let calls = 0, cancelled = 0;
  const {download} = downloader(async () => new Response(new ReadableStream({cancel() { cancelled++; }}), {status: ++calls === 1 ? 503 : 404}));
  await assert.rejects(download('https://test/root', 'root'), /root: 404/);
  assert.equal(calls, 2);
  assert.equal(cancelled, 2);
});

test('root download caps both fetch and body failures at five attempts', async () => {
  for (const body of [false, true]) {
    let calls = 0;
    const {download, delays} = downloader(async () => {
      calls++;
      if (!body) throw new Error('fetch cut');
      return new Response(new ReadableStream({start(c) { c.error(new Error('body cut')); }}));
    });
    await assert.rejects(download('https://test/root', 'root'), /root: (fetch|body) cut/);
    assert.equal(calls, 5);
    assert.deepEqual(delays, [4000, 8000, 16000, 32000]);
  }
});
