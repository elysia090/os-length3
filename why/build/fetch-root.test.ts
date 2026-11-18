import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {promisify} from 'node:util';
import {test} from 'node:test';
import {downloadRoot} from './fetch-root.ts';

function downloader(get: typeof fetch) {
  const delays: number[] = [];
  const download = (url: string, what: string) => downloadRoot(url, what, {
    get,
    async pause(ms) { delays.push(ms); },
    warn() {},
  });
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


test('concurrent downloaders leave one fully verified cache entry and no staging directories', {timeout: 15_000}, async t => {
  const work = mkdtempSync(join(tmpdir(), 'why-root-download-'));
  t.after(() => rmSync(work, {recursive: true, force: true}));
  for (const file of ['why/build/fetch-root.ts', 'why/shipto/release-pins.ts', 'why/shipto/desktop-releases.json']) {
    const dest = join(work, file);
    mkdirSync(dirname(dest), {recursive: true});
    copyFileSync(new URL(`../../${file}`, import.meta.url), dest);
  }
  const file = 'fixture.tar.zst', body = 'one finished archive';
  const sha256 = createHash('sha256').update(body).digest('hex');
  const pins = join(work, 'why/prompt/roots/pins.rs');
  mkdirSync(dirname(pins), {recursive: true});
  writeFileSync(pins, `pub const RELEASES: &[Release] = &[Release { name: "fixture", version: "1", sha256: "${sha256}", bytes: ${Buffer.byteLength(body)}, file: "${file}", tag: "v1", web: "", }];`);
  const arrivals = join(work, 'arrivals');
  mkdirSync(arrivals);
  const preload = join(work, 'download.mjs');
  writeFileSync(preload, `
import {readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
globalThis.fetch = async url => {
  if (url !== 'https://fixture.test/releases/v1/${file}') throw Error('unexpected URL');
  const arrivals = ${JSON.stringify(arrivals)};
  writeFileSync(join(arrivals, String(process.pid)), '');
  while (readdirSync(arrivals).length < 2) await new Promise(resolve => setTimeout(resolve, 10));
  return new Response(${JSON.stringify(body)});
};
`);
  const cache = join(work, 'package cache'), run = promisify(execFile);
  const args = ['--import', preload, join(work, 'why/build/fetch-root.ts'), cache];
  const options = {cwd: work, env: {...process.env, WHY_RELEASES: 'https://fixture.test/releases'}, timeout: 10_000};
  const downloads = await Promise.all([run(process.execPath, args, options), run(process.execPath, args, options)]);
  const artifact = join(cache, file);
  for (const result of downloads) assert.equal(result.stdout.trim(), artifact);
  assert.equal(readFileSync(artifact, 'utf8'), body);
  assert.deepEqual(readdirSync(cache), [file]);
});
