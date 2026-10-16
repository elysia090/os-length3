import assert from 'node:assert/strict';
import {createServer, type IncomingMessage, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import {test} from 'node:test';
import {digest, download, Fatal} from './fetch.ts';

// A server that behaves like the proxies in between: it cuts, stalls,
// errors for a while, ignores Range or changes the file between tries.
type Step = 'cut' | 'stall' | '503' | 'full' | 'norange' | 'swap';

async function serve(body: Uint8Array, steps: Step[]) {
  let file = body;
  const seen: (string | undefined)[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push(req.headers.range);
    const step = steps.shift() ?? 'full';
    if (step === '503') { res.writeHead(503).end(); return; }
    if (step === 'swap') file = file.map((b) => b ^ 1);
    const etag = `"v${file[0]}"`;
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    const resume = m && step !== 'norange' && req.headers['if-range'] === etag;
    const start = resume ? Number(m![1]) : 0;
    const rest = file.subarray(start);
    res.writeHead(resume ? 206 : 200, {
      'Content-Length': rest.length, ETag: etag,
      ...(resume ? {'Content-Range': `bytes ${start}-${file.length - 1}/${file.length}`} : {}),
    });
    if (step === 'cut') { res.write(rest.subarray(0, rest.length >> 1)); setTimeout(() => res.destroy(), 20); return; }
    if (step === 'stall') { res.write(rest.subarray(0, rest.length >> 2)); return; }
    res.end(rest);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/f`;
  return {url, seen, close: () => { server.closeAllConnections(); server.close(); }};
}

const body = new Uint8Array(200_000).map((_, i) => (i * 7) & 255);
const fast = {stallMs: 200, backoff: () => 10};

test('a cut transfer continues from the byte it reached', async () => {
  const s = await serve(body, ['cut', 'cut']);
  const retries: string[] = [];
  const got = await download(s.url, {size: body.length, sha256: await digest(body)},
    {bytes() {}, retry(_, why) { retries.push(why); }}, fast);
  s.close();
  assert.deepEqual(got, body);
  assert.equal(retries.length, 2);
  // The second and third asked only for the rest.
  assert.equal(s.seen[0], undefined);
  assert.match(s.seen[1]!, /^bytes=\d+-$/);
  assert.ok(Number(/=(\d+)/.exec(s.seen[2]!)![1]) > Number(/=(\d+)/.exec(s.seen[1]!)![1]));
});

test('a stalled transfer is noticed and taken up again', async () => {
  const s = await serve(body, ['stall']);
  const retries: string[] = [];
  const got = await download(s.url, {sha256: await digest(body)}, {bytes() {}, retry(_, why) { retries.push(why); }}, fast);
  s.close();
  assert.deepEqual(got, body);
  assert.deepEqual(retries, ['回線が止まりました']);
});

test('a moment of server errors is waited out; a missing file is not', async () => {
  const s = await serve(body, ['503', '503']);
  assert.deepEqual(await download(s.url, {}, undefined, fast), body);
  s.close();
  const t = createServer((_, res) => res.writeHead(404).end());
  await new Promise<void>((r) => t.listen(0, '127.0.0.1', r));
  await assert.rejects(download(`http://127.0.0.1:${(t.address() as AddressInfo).port}/x`, {}, undefined, fast), Fatal);
  t.close();
});

test('a server that cannot continue sends all of it, and nothing is spliced', async () => {
  const s = await serve(body, ['cut', 'norange']);
  const seen: number[] = [];
  const got = await download(s.url, {sha256: await digest(body)}, {bytes(n) { seen.push(n); }, retry() {}}, fast);
  s.close();
  assert.deepEqual(got, body);
  // It went back to 0 when the whole file came again.
  assert.ok(seen.includes(0));
});

test('a file changed between tries is never joined to the old half', async () => {
  const s = await serve(body, ['cut', 'swap']);
  const changed = body.map((b) => b ^ 1);
  // If-Range no longer matches, so the server sends the new file whole.
  const got = await download(s.url, {}, undefined, fast);
  s.close();
  assert.deepEqual(got, changed);
});

test('bytes that are not the file named are refused after every try', async () => {
  const s = await serve(body, []);
  await assert.rejects(download(s.url, {sha256: '0'.repeat(64)}, undefined, {...fast, attempts: 2}), /中身が合いません/);
  s.close();
});

test('a quiet line is said each second before it counts as broken', async () => {
  const s = await serve(body, ['stall']);
  const quiet: number[] = [];
  const got = await download(s.url, {}, {bytes() {}, retry() {}, waiting(n) { quiet.push(n); }}, {stallMs: 3500, backoff: () => 10});
  s.close();
  assert.deepEqual(got, body);
  // Said while quiet, from the second second, counting up (a tick may land late under load).
  assert.ok(quiet.length >= 1 && quiet.every((n, i) => n >= 2 && n < 4 && (i === 0 || n > quiet[i - 1])), String(quiet));
});
