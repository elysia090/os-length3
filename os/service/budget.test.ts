import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sql} from 'drizzle-orm';
import {LIMITS, limitsOf, type Limits} from './budget.ts';
import type {Bucket} from './bucket.ts';
import type {Edge} from './files.ts';
import {sha256} from './request.ts';
import {count, enc, service, type Service} from './testing.ts';

// What R2 and the database may be asked for (budget.ts): each limit is checked before R2 is asked, and what
// is refused leaves nothing counted and nothing kept.

const MB = 1024 ** 2;
const limits = (o: Partial<Limits>): Limits => ({...LIMITS, ...o});

/** How often the bucket was asked, by what. */
function counted(s: Service) {
  const asked = {get: 0, put: 0, size: 0, read: 0};
  const b = s.bucket as Bucket;
  for (const k of Object.keys(asked) as (keyof typeof asked)[]) {
    const real = b[k].bind(b) as (...a: unknown[]) => unknown;
    (b as unknown as Record<string, unknown>)[k] = (...a: unknown[]) => { asked[k]++; return real(...a); };
  }
  return asked;
}

const usage = async (s: Service, kind: string) =>
  Number(((await s.db.execute(sql`select coalesce(sum(n), 0)::float8 as n from usage where kind = ${kind}`)).rows as {n: number}[])[0].n);

async function put(s: Service, t: string, text: string) {
  const bytes = enc.encode(text);
  const sha = await sha256(bytes);
  return {sha, r: await s.call('PUT', `/v1/blobs/${sha}`, {token: t, bytes})};
}

test('a deployment\'s limits are its variables, in MB where they are bytes; one unsaid or not a number is the default', () => {
  assert.deepEqual(limitsOf({}), LIMITS);
  const l = limitsOf({R2_STORED_MB: '10', R2_WRITES_MONTH: '5', R2_READS_MONTH: 'many', UPLOAD_MB_DAY: '0', PG_MB: '2'});
  assert.deepEqual(l, {...LIMITS, stored: 10 * MB, writes: 5, database: 2 * MB});
});

test('R2\'s puts of the month: one past them is refused before R2 is asked, as no files, and nothing is kept or counted', async () => {
  const s = await service({}, {limits: limits({writes: 1})});
  const asked = counted(s);
  const t = await s.start();
  assert.equal((await put(s, t, 'one')).r.status, 201);
  const two = await put(s, t, 'two');
  assert.equal(two.r.status, 503);
  assert.deepEqual([two.r.json.files, two.r.json.budget], [false, true]);
  assert.ok(Number(two.r.headers.get('Retry-After')) > 0);
  assert.equal(asked.put, 1);
  assert.equal(await usage(s, 'r2:a'), 1);
  assert.equal(await count(s, sql`select count(*)::int as n from blob`), 1);
  // A blob it has already is no put at all.
  assert.equal((await put(s, t, 'one')).r.status, 201);
});

test('the bytes R2 holds are counted with the rows that name them, and an upload past them is refused (507)', async () => {
  const s = await service({}, {limits: limits({stored: 10})});
  const asked = counted(s);
  const t = await s.start();
  assert.equal((await put(s, t, '12345678')).r.status, 201);
  assert.equal(await usage(s, 'r2:stored'), 8);
  const over = await put(s, t, 'abcdefgh');
  assert.deepEqual([over.r.status, over.r.json.files], [507, false]);
  assert.equal(asked.put, 1);
  // A blob that goes takes its bytes out of the count (the sweep deletes its row).
  await s.db.execute(sql`delete from blob`);
  assert.equal(await usage(s, 'r2:stored'), 0);
});

test('what one account sends in a day: past it, refused until tomorrow (429); another account is not held back', async () => {
  const s = await service({}, {limits: limits({upload: 10})});
  const t = await s.start('Ren'), u = await s.start('Bo');
  assert.equal((await put(s, t, '12345678')).r.status, 201);
  const over = await put(s, t, 'abcdefgh');
  assert.equal(over.r.status, 429);
  assert.ok(Number(over.r.headers.get('Retry-After')) > 0);
  assert.equal((await put(s, u, 'abcdefgh')).r.status, 201);
});

test('reads are taken a few at a time, and past the month\'s none reaches R2', async () => {
  const s = await service({}, {limits: limits({reads: 3})});
  const t = await s.start();
  const {sha} = await put(s, t, 'hello');
  const asked = counted(s);
  for (let i = 0; i < 3; i++) assert.equal((await s.call('GET', `/v1/blobs/${sha}`, {token: t})).status, 200);
  const over = await s.call('GET', `/v1/blobs/${sha}`, {token: t});
  assert.deepEqual([over.status, over.json.files], [503, false]);
  assert.equal(asked.get, 3);
  assert.equal(await usage(s, 'r2:b'), 3);

  // With room, a Worker takes many at once: one statement for many reads.
  const roomy = await service({}, {limits: limits({reads: 1000})});
  const r = await roomy.start();
  const f = await put(roomy, r, 'hello');
  for (let i = 0; i < 5; i++) await roomy.call('GET', `/v1/blobs/${f.sha}`, {token: r});
  assert.equal(await usage(roomy, 'r2:b'), 64);
});

test('a file asked for again by one who has it is answered 304, and R2 is asked nothing', async () => {
  const s = await service({}, {limits: limits({})});
  const t = await s.start();
  const {sha} = await put(s, t, 'hello');
  const asked = counted(s);
  const again = await s.call('GET', `/v1/blobs/${sha}`, {token: t, headers: {'If-None-Match': `"${sha}"`}});
  assert.deepEqual([again.status, again.headers.get('ETag')], [304, `"${sha}"`]);
  assert.equal(asked.get, 0);
});

test('a request that names no session is refused before anything is looked up', async () => {
  const s = await service();
  assert.equal((await s.call('GET', '/v1/repos')).status, 401);
  assert.equal((await s.call('PUT', '/v1/blobs/' + 'a'.repeat(64), {bytes: enc.encode('x')})).status, 401);
});

test('a release file is read from R2 once, then the edge\'s cache answers every range and HEAD', async () => {
  const kept = new Map<string, {body: Uint8Array; headers: Headers}>();
  // The Cache API's way: it keeps a whole answer, and answers a Range request from it.
  const edge: Edge = {
    async put(req, res) { kept.set(req.url, {body: new Uint8Array(await res.arrayBuffer()), headers: res.headers}); },
    async match(req) {
      const k = kept.get(req.url);
      if (!k) return undefined;
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get('Range') ?? '');
      if (!m) return new Response(k.body as BodyInit, {headers: k.headers});
      const end = m[2] ? Number(m[2]) : k.body.length - 1;
      const h = new Headers(k.headers);
      h.set('Content-Range', `bytes ${m[1]}-${end}/${k.body.length}`);
      h.set('Content-Length', String(end - Number(m[1]) + 1));
      return new Response(k.body.slice(Number(m[1]), end + 1) as BodyInit, {status: 206, headers: h});
    },
  };
  const s = await service({}, {limits: limits({}), edge});
  const sha = 'b'.repeat(64);
  await s.bucket.put(`os/${sha}`, new Uint8Array(100).map((_, i) => i));
  const record = (key: string, bytes: number) => s.db.execute(sql`insert into release_file (key, sha256, bytes) values (${key}, ${'d'.repeat(64)}, ${bytes})`);
  await record(`os/${sha}`, 100);
  const asked = counted(s);
  const part = await s.call('GET', `/v1/os/${sha}`, {headers: {Range: 'bytes=10-19'}});
  assert.deepEqual([part.status, part.headers.get('Content-Range')], [206, 'bytes 10-19/100']);
  const reads = asked.size + asked.read;
  for (const range of ['bytes=0-0', 'bytes=50-99']) assert.equal((await s.call('GET', `/v1/os/${sha}`, {headers: {Range: range}})).status, 206);
  assert.equal((await s.app.request(`http://remote.test/v1/os/${sha}`, {method: 'HEAD'})).status, 200);
  assert.equal(asked.size + asked.read, reads);
  // A digest the deploy never recorded is 404 without R2 being asked, however many are asked for.
  const before = asked.size + asked.read;
  for (let i = 0; i < 5; i++) assert.equal((await s.call('GET', `/v1/os/${String(i).repeat(64)}`)).status, 404);
  assert.equal(asked.size + asked.read, before);
  // A release not there is not cached as absent: once the deploy puts and records it, it is there.
  const none = 'c'.repeat(64);
  assert.equal((await s.call('GET', `/v1/os/${none}`)).status, 404);
  await s.bucket.put(`os/${none}`, new Uint8Array(3));
  await record(`os/${none}`, 3);
  assert.equal((await s.call('GET', `/v1/os/${none}`)).status, 200);
  // What R2 holds counts the release files with the blobs.
  assert.equal(await usage(s, 'r2:stored'), 103);
});

test('a database at all it may take takes nothing new; reads, deletes and signing in go on', async () => {
  const s = await service({}, {limits: limits({database: 1})});
  const t = await s.start();
  const full = await s.call('PUT', '/v1/home/profile', {token: t, body: {json: '{}'}});
  assert.deepEqual([full.status, full.json.budget], [507, true]);
  assert.equal((await s.call('GET', '/v1/repos', {token: t})).status, 200);
  assert.equal((await s.call('POST', '/v1/blobs/missing', {token: t, body: []})).status, 200);
});

test('asked too often, a session is refused at the edge (429) before the database is asked', async () => {
  let left = Infinity;
  const s = await service({}, {limiter: {limit: async () => ({success: left-- > 0})}});
  const t = await s.start();
  left = 0;
  const r = await s.call('GET', '/v1/repos', {token: t});
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('Retry-After'), '60');
});
