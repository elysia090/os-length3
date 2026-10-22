import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Hono} from 'hono';
import {sql} from 'drizzle-orm';
import {failed, ms, refuse, rows} from './request.ts';
import {freshDb, sharedService} from './testing.ts';

// What the Remote answers when something fails that no route foresaw
// (request.ts failed): JSON with words and an id, 503 with when to try again
// when the database is busy or out of reach, 500 otherwise; a refusal is its
// own answer.

const app = new Hono();
app.onError(failed);
const thrown = (e: unknown) => () => { throw e; };
const pg = (code: string) => Object.assign(new Error('from Postgres'), {code});
app.get('/lock', thrown(pg('55P03')));
app.get('/gone', thrown(pg('08006')));
app.get('/wrapped', thrown(Object.assign(new Error('Failed query'), {cause: pg('57014')})));
app.get('/unique', thrown(pg('23505')));
app.get('/bug', thrown(new TypeError('x is undefined')));
app.get('/refused', () => refuse(409, {error: 'No', version: 3}));

test('an unforeseen failure is JSON with words and an id; the database busy or away is 503 with when to try again', async () => {
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const path of ['/lock', '/gone', '/wrapped']) {
      const r = await app.request(path);
      assert.equal(r.status, 503, path);
      assert.equal(r.headers.get('Retry-After'), '5');
      const b = await r.json() as {error: string; id: string};
      assert.equal(b.error, 'The Remote is busy just now; try again');
      assert.match(b.id, /^[0-9a-f]{12}$/);
    }
    for (const path of ['/unique', '/bug']) {
      const r = await app.request(path);
      assert.equal(r.status, 500, path);
      const b = await r.json() as {error: string; id: string};
      assert.deepEqual([b.error, /^[0-9a-f]{12}$/.test(b.id), JSON.stringify(b).includes('undefined')], ['Something went wrong on the Remote', true, false]);
    }
    const r = await app.request('/refused');
    assert.deepEqual([r.status, await r.json()], [409, {error: 'No', version: 3}]);
  } finally { console.error = quiet; }
});

test('the Remote\'s own routes answer so: a setting\'s version past what Postgres holds is no bare text 500', async () => {
  const s = await sharedService();
  const t = await s.person('Overflowing');
  const quiet = console.error;
  console.error = () => {};
  try {
    const r = await s.call('PUT', '/v1/home/todo', {token: t, body: {value: '[]', version: 2 ** 40}});
    assert.ok(r.status === 500 || r.status < 500, r.text);
    if (r.status === 500) assert.equal(r.json.error, 'Something went wrong on the Remote');
    assert.match(r.headers.get('Content-Type') ?? '', /json/);
  } finally { console.error = quiet; }
});

test('a moment is read as whole milliseconds, though Postgres keeps microseconds (core and l3 read a u64)', async () => {
  const db = await freshDb();
  const [r] = await rows<{t: number}>(db, sql`select ${ms(sql`'2026-10-18 06:49:17.528123+00'::timestamptz`)} as t`);
  assert.equal(r.t, Date.UTC(2026, 9, 18, 6, 49, 17, 528));
  assert.ok(Number.isInteger(r.t));
});
