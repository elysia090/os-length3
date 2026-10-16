import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cutId, handle, memoryBucket, sha256, type Cut} from './remote.ts';

const enc = new TextEncoder();
const base = 'https://remote.test';

function client(bucket = memoryBucket()) {
  let clock = 1000;
  const call = (method: string, path: string, init: {token?: string; body?: unknown; bytes?: Uint8Array; headers?: Record<string, string>} = {}) =>
    handle(new Request(base + path, {
      method,
      headers: {...(init.token ? {Authorization: `Bearer ${init.token}`} : {}), ...(init.headers ?? {})},
      body: (init.bytes as BodyInit | undefined) ?? (init.body === undefined ? undefined : JSON.stringify(init.body)),
    }), bucket, {now: () => ++clock, origins: ['https://app.test']});
  return {bucket, call};
}

async function signUp(c: ReturnType<typeof client>) {
  const r = await c.call('POST', '/v1/accounts');
  assert.equal(r.status, 201);
  return (await r.json()).token as string;
}

test('nothing is answered without an account, and an account is only its token', async () => {
  const c = client();
  assert.equal((await c.call('GET', '/v1/repos')).status, 401);
  assert.equal((await c.call('GET', '/v1/repos', {token: 'x'.repeat(43)})).status, 401);
  const t = await signUp(c);
  assert.deepEqual(await (await c.call('GET', '/v1/repos', {token: t})).json(), []);
  // The token itself is never stored, as a key or in what is kept.
  const bucket = c.bucket as ReturnType<typeof memoryBucket>;
  for (const [k, v] of bucket.entries()) assert.ok(!k.includes(t) && !new TextDecoder().decode(v).includes(t), k);
});

test('a blob is taken only as the bytes its name says', async () => {
  const c = client();
  const t = await signUp(c);
  const bytes = enc.encode('hello\n');
  const sha = await sha256(bytes);
  assert.equal((await c.call('PUT', `/v1/blobs/${'0'.repeat(64)}`, {token: t, bytes})).status, 422);
  assert.deepEqual(await (await c.call('POST', '/v1/blobs/missing', {token: t, body: [sha]})).json(), [sha]);
  assert.equal((await c.call('PUT', `/v1/blobs/${sha}`, {token: t, bytes})).status, 201);
  assert.deepEqual(await (await c.call('POST', '/v1/blobs/missing', {token: t, body: [sha]})).json(), []);
  assert.equal(await (await c.call('GET', `/v1/blobs/${sha}`, {token: t})).text(), 'hello\n');
  // Another account cannot read it, even knowing its name.
  const other = await signUp(c);
  assert.equal((await c.call('GET', `/v1/blobs/${sha}`, {token: other})).status, 404);
});

test('a cut moves the head only from its parent; a stale push is refused with the head', async () => {
  const c = client();
  const t = await signUp(c);
  const readme = enc.encode('# notes\n');
  const sha = await sha256(readme);
  const cut = (parent: string | null, extra: Record<string, string | null> = {}) =>
    c.call('POST', '/v1/repos/notes/cuts', {token: t, body: {parent, tree: {'README.md': sha, src: null, ...extra}, kind: 'Fix', title: 'first', issue: '', note: ''}});

  // Files first: a cut naming a blob that is not there says which.
  const missing = await cut(null);
  assert.equal(missing.status, 409);
  assert.deepEqual((await missing.json()).missing, [sha]);
  await c.call('PUT', `/v1/blobs/${sha}`, {token: t, bytes: readme});

  const first = await cut(null);
  assert.equal(first.status, 201);
  const {id} = await first.json();
  // The id is the digest of what was stored: anyone can check it.
  const stored = await (await c.call('GET', `/v1/cuts/${id}`, {token: t})).json() as Cut;
  const {id: _, ...rest} = stored;
  assert.equal(await cutId(rest), id);

  // Two devices push from the same parent: one lands, the other is told the new head.
  const second = await cut(id, {'b.md': sha});
  assert.equal(second.status, 201);
  const secondId = (await second.json()).id;
  const stale = await cut(id, {'c.md': sha});
  assert.equal(stale.status, 409);
  assert.deepEqual(await stale.json(), {head: secondId});
  // A first push for a repo that already exists is stale too.
  assert.equal((await cut(null)).status, 409);

  const list = await (await c.call('GET', '/v1/repos', {token: t})).json();
  assert.deepEqual(list.map((r: {name: string; head: string}) => [r.name, r.head]), [['notes', secondId]]);
  const log = await (await c.call('GET', '/v1/repos/notes/log', {token: t})).json() as Cut[];
  assert.deepEqual(log.map((x) => x.id), [secondId, id]);
});

test('paths that leave the repo or touch .git never get in', async () => {
  const c = client();
  const t = await signUp(c);
  for (const p of ['../x', '/etc/passwd', 'a//b', '.git/config', 'src/.GIT./hooks', 'git~1', 'a/./b']) {
    const r = await c.call('POST', '/v1/repos/r/cuts', {token: t, body: {parent: null, tree: {[p]: null}, kind: '', title: 't', issue: '', note: ''}});
    assert.equal(r.status, 400, p);
  }
  assert.equal((await c.call('POST', '/v1/repos/..%2Fx/cuts', {token: t, body: {}})).status, 404);
});

test('Home settings change only from the version they were read at', async () => {
  const c = client();
  const t = await signUp(c);
  assert.equal((await c.call('PUT', '/v1/home/todo', {token: t, body: []})).status, 428);
  const made = await c.call('PUT', '/v1/home/todo', {token: t, body: ['a'], headers: {'If-None-Match': '*'}});
  assert.equal(made.status, 200);
  const v1 = made.headers.get('ETag')!;
  const next = await c.call('PUT', '/v1/home/todo', {token: t, body: ['a', 'b'], headers: {'If-Match': v1}});
  assert.equal(next.status, 200);
  // A device still at v1 is refused and told the version there is now.
  const stale = await c.call('PUT', '/v1/home/todo', {token: t, body: ['c'], headers: {'If-Match': v1}});
  assert.equal(stale.status, 412);
  assert.equal((await stale.json()).etag, next.headers.get('ETag'));
  assert.deepEqual(await (await c.call('GET', '/v1/home/todo', {token: t})).json(), ['a', 'b']);
});

test('only the app\'s origin may call from a page', async () => {
  const c = client();
  const ok = await c.call('OPTIONS', '/v1/repos', {headers: {Origin: 'https://app.test'}});
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), 'https://app.test');
  const other = await c.call('OPTIONS', '/v1/repos', {headers: {Origin: 'https://evil.test'}});
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);
});
