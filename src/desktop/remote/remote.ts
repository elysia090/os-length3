// The Remote: where the canonical copy of everything lives. A device's copy
// is a checkout and is not trusted: whatever it sends is checked here, and
// whatever it gets can be checked by it, because everything is named by its
// content. A file is a blob named by its sha256; a cut (区切り) is a JSON
// record of a repo's whole tree, its parent cut and its words, named by the
// sha256 of that record; a repo is only a pointer, its head, to one cut.
// The head moves by compare-and-set: a push whose parent is not the head is
// refused with the head, so no push ever overwrites another.
//
// One handler, three hosts: the Worker (worker.ts, over R2), a local server
// (serve.ts, over a directory) and the tests (over memory).
//
//   POST /v1/accounts                      -> {token} (shown once; the account is its digest)
//   POST /v1/blobs/missing  [sha…]         -> [sha…] not there yet
//   PUT  /v1/blobs/:sha     bytes          (refused unless the bytes are that sha)
//   GET  /v1/blobs/:sha
//   GET  /v1/repos                         -> [{name, head, time, title, kind}]
//   GET  /v1/repos/:name                   -> the head cut, or 404
//   GET  /v1/repos/:name/log?limit=n       -> cuts, newest first
//   POST /v1/repos/:name/cuts  {parent, tree, kind, title, issue, note}
//                                          -> 201 {id} | 409 {head} | 409 {missing}
//   GET  /v1/cuts/:id
//   GET  /v1/home/:key (204 when not set) / PUT with If-Match (a version) or If-None-Match: *

export interface Stored { bytes: Uint8Array; etag: string }

/** What R2 gives: objects by key, and a put that holds only under a condition. */
export interface Bucket {
  get(key: string): Promise<Stored | null>;
  /** null when `onlyIf` did not hold. */
  put(key: string, bytes: Uint8Array, onlyIf?: {etag?: string; absent?: boolean}): Promise<{etag: string} | null>;
  head(key: string): Promise<boolean>;
}

export interface Cut {
  id: string;
  repo: string;
  parent: string | null;
  /** path -> blob sha256, or null for a directory that holds nothing. */
  tree: Record<string, string | null>;
  kind: string;
  title: string;
  issue: string;
  note: string;
  time: number;
}

const LIMIT = {blob: 16 << 20, cut: 4 << 20, home: 1 << 20, files: 20_000, missing: 5_000, log: 200};
const enc = new TextEncoder(), dec = new TextDecoder();

export async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The id a cut has: the digest of its content in one fixed order. */
export async function cutId(c: Omit<Cut, 'id'>): Promise<string> {
  const tree = Object.keys(c.tree).sort().map((p) => [p, c.tree[p]]);
  return sha256(enc.encode(JSON.stringify([c.repo, c.parent, tree, c.kind, c.title, c.issue, c.note, c.time])));
}

const HEX = /^[0-9a-f]{64}$/;
const validName = (n: string) => /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(n);
/** A repo path as the app allows one: no .., no empty part, never .git however spelt. */
function validPath(p: string): boolean {
  if (!p || p.length > 1024 || p.startsWith('/')) return false;
  return p.split('/').every((part) => {
    if (!part || part === '.' || part === '..') return false;
    const n = part.replace(/[‌-‏‪-‮⁪-⁯﻿]/g, '').toLowerCase().replace(/[. ]+$/, '');
    return n !== '.git' && n !== 'git~1';
  });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json', ...headers}});
const fail = (status: number, message: string) => json(status, {error: message});

async function body(request: Request, limit: number): Promise<Uint8Array | null> {
  const length = Number(request.headers.get('Content-Length') ?? '0');
  if (length > limit) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.length > limit ? null : bytes;
}

async function readJson<T>(request: Request, limit: number): Promise<T | null> {
  const b = await body(request, limit);
  if (!b) return null;
  try { return JSON.parse(dec.decode(b)) as T; } catch { return null; }
}

/** Who asks: the account is the digest of the token, so the token is never stored. */
async function account(bucket: Bucket, request: Request): Promise<string | null> {
  const m = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(request.headers.get('Authorization') ?? '');
  if (!m) return null;
  const id = (await sha256(enc.encode(m[1]))).slice(0, 32);
  return (await bucket.head(`acct/${id}/account`)) ? id : null;
}

function token(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface Options {
  /** Origins whose pages may call (the app's); none means same-origin only. */
  origins?: string[];
  now?: () => number;
}

export async function handle(request: Request, bucket: Bucket, options: Options = {}): Promise<Response> {
  const cors = corsHeaders(request, options.origins ?? []);
  if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: cors});
  const response = await route(request, bucket, options).catch(() => fail(500, 'remote failed'));
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, {status: response.status, headers});
}

function corsHeaders(request: Request, origins: string[]): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!origin || !origins.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin, Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match',
    'Access-Control-Expose-Headers': 'ETag',
    'Access-Control-Max-Age': '600',
  };
}

async function route(request: Request, bucket: Bucket, options: Options): Promise<Response> {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'v1') return fail(404, 'not found');
  const [, what, a, b] = parts;
  const now = options.now ?? Date.now;

  if (what === 'accounts' && !a && request.method === 'POST') {
    const t = token();
    const id = (await sha256(enc.encode(t))).slice(0, 32);
    await bucket.put(`acct/${id}/account`, enc.encode(JSON.stringify({created: now()})), {absent: true});
    return json(201, {token: t});
  }

  const me = await account(bucket, request);
  if (!me) return fail(401, 'no account');
  const at = (k: string) => `acct/${me}/${k}`;

  if (what === 'blobs') {
    if (a === 'missing' && request.method === 'POST') {
      const list = await readJson<string[]>(request, 1 << 20);
      if (!Array.isArray(list) || list.length > LIMIT.missing || !list.every((s) => typeof s === 'string' && HEX.test(s))) return fail(400, 'a list of digests');
      const missing: string[] = [];
      for (const s of new Set(list)) if (!(await bucket.head(at(`blob/${s}`)))) missing.push(s);
      return json(200, missing);
    }
    if (!a || !HEX.test(a) || b) return fail(404, 'not found');
    if (request.method === 'PUT') {
      const bytes = await body(request, LIMIT.blob);
      if (!bytes) return fail(413, 'too large');
      if (await sha256(bytes) !== a) return fail(422, 'bytes are not that digest');
      await bucket.put(at(`blob/${a}`), bytes);
      return json(201, {sha256: a});
    }
    if (request.method === 'GET') {
      const o = await bucket.get(at(`blob/${a}`));
      return o ? new Response(o.bytes as BodyInit, {headers: {'Content-Type': 'application/octet-stream', ETag: `"${a}"`}}) : fail(404, 'no blob');
    }
    return fail(405, 'method');
  }

  if (what === 'cuts' && a && HEX.test(a) && request.method === 'GET') {
    const o = await bucket.get(at(`cut/${a}`));
    return o ? new Response(o.bytes as BodyInit, {headers: {'Content-Type': 'application/json'}}) : fail(404, 'no cut');
  }

  if (what === 'repos') {
    if (!a && request.method === 'GET') {
      const index = await bucket.get(at('repos'));
      const names: string[] = index ? JSON.parse(dec.decode(index.bytes)) : [];
      const out = [];
      for (const name of names) {
        const head = await headOf(bucket, at, name);
        if (!head) continue;
        const c = await cutOf(bucket, at, head.cut);
        if (c) out.push({name, head: c.id, time: c.time, title: c.title, kind: c.kind});
      }
      return json(200, out);
    }
    if (!a || !validName(a)) return fail(404, 'not found');
    if (!b && request.method === 'GET') {
      const head = await headOf(bucket, at, a);
      const c = head && await cutOf(bucket, at, head.cut);
      return c ? json(200, c) : fail(404, 'no repo');
    }
    if (b === 'log' && request.method === 'GET') {
      const limit = Math.min(LIMIT.log, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50));
      const out: Cut[] = [];
      let id = (await headOf(bucket, at, a))?.cut ?? null;
      while (id && out.length < limit) { const c = await cutOf(bucket, at, id); if (!c) break; out.push(c); id = c.parent; }
      return json(200, out);
    }
    if (b === 'cuts' && request.method === 'POST') {
      const c = await readJson<Omit<Cut, 'id' | 'repo' | 'time'>>(request, LIMIT.cut);
      if (!c || typeof c.tree !== 'object' || c.tree === null) return fail(400, 'a cut');
      const paths = Object.keys(c.tree);
      if (paths.length > LIMIT.files) return fail(413, 'too many files');
      for (const p of paths) {
        const v = c.tree[p];
        if (!validPath(p) || !(v === null || (typeof v === 'string' && HEX.test(v)))) return fail(400, `path ${p}`);
      }
      for (const k of ['kind', 'title', 'issue', 'note'] as const) if (typeof c[k] !== 'string' || c[k].length > 2000) return fail(400, k);
      if (c.parent !== null && !(typeof c.parent === 'string' && HEX.test(c.parent))) return fail(400, 'parent');
      const missing: string[] = [];
      for (const s of new Set(Object.values(c.tree).filter((v): v is string => v !== null))) {
        if (!(await bucket.head(at(`blob/${s}`)))) missing.push(s);
      }
      if (missing.length) return json(409, {missing});
      const head = await headOf(bucket, at, a);
      if ((head?.cut ?? null) !== c.parent) return json(409, {head: head?.cut ?? null});
      const record: Omit<Cut, 'id'> = {repo: a, parent: c.parent, tree: c.tree, kind: c.kind, title: c.title, issue: c.issue, note: c.note, time: now()};
      const id = await cutId(record);
      await bucket.put(at(`cut/${id}`), enc.encode(JSON.stringify({id, ...record})));
      // The one mutable step: the head moves only from the parent it was given.
      const moved = await bucket.put(at(`head/${a}`), enc.encode(JSON.stringify({cut: id})),
        head ? {etag: head.etag} : {absent: true});
      if (!moved) return json(409, {head: (await headOf(bucket, at, a))?.cut ?? null});
      if (!head) await addName(bucket, at, a);
      return json(201, {id});
    }
    return fail(405, 'method');
  }

  if (what === 'home' && a && /^[a-z]{1,32}$/.test(a) && !b) {
    const key = at(`home/${a}`);
    if (request.method === 'GET') {
      const o = await bucket.get(key);
      // Not set yet is an answer, not a failure.
      return o ? new Response(o.bytes as BodyInit, {headers: {'Content-Type': 'application/json', ETag: o.etag}}) : new Response(null, {status: 204});
    }
    if (request.method === 'PUT') {
      const bytes = await body(request, LIMIT.home);
      if (!bytes) return fail(413, 'too large');
      try { JSON.parse(dec.decode(bytes)); } catch { return fail(400, 'json'); }
      const ifMatch = request.headers.get('If-Match'), ifNone = request.headers.get('If-None-Match');
      if (!ifMatch && ifNone !== '*') return fail(428, 'If-Match or If-None-Match: *');
      const put = await bucket.put(key, bytes, ifMatch ? {etag: ifMatch} : {absent: true});
      if (!put) { const o = await bucket.get(key); return json(412, {etag: o?.etag ?? null}); }
      return json(200, {}, {ETag: put.etag});
    }
    return fail(405, 'method');
  }
  return fail(404, 'not found');
}

async function headOf(bucket: Bucket, at: (k: string) => string, repo: string): Promise<{cut: string; etag: string} | null> {
  const o = await bucket.get(at(`head/${repo}`));
  return o ? {cut: JSON.parse(dec.decode(o.bytes)).cut, etag: o.etag} : null;
}

async function cutOf(bucket: Bucket, at: (k: string) => string, id: string): Promise<Cut | null> {
  const o = await bucket.get(at(`cut/${id}`));
  return o ? JSON.parse(dec.decode(o.bytes)) as Cut : null;
}

/** The list of repo names, added to by compare-and-set so two first pushes both land. */
async function addName(bucket: Bucket, at: (k: string) => string, name: string) {
  for (let i = 0; i < 8; i++) {
    const o = await bucket.get(at('repos'));
    const names: string[] = o ? JSON.parse(dec.decode(o.bytes)) : [];
    if (names.includes(name)) return;
    const put = await bucket.put(at('repos'), enc.encode(JSON.stringify([...names, name])), o ? {etag: o.etag} : {absent: true});
    if (put) return;
  }
}

/** A Bucket in memory, for tests. */
export function memoryBucket(): Bucket & {entries(): [string, Uint8Array][]} {
  const m = new Map<string, Stored>();
  let n = 0;
  return {
    entries() { return [...m].map(([k, o]) => [k, o.bytes]); },
    async get(k) { const o = m.get(k); return o ? {bytes: o.bytes.slice(), etag: o.etag} : null; },
    async head(k) { return m.has(k); },
    async put(k, bytes, onlyIf) {
      const o = m.get(k);
      if (onlyIf?.absent && o) return null;
      if (onlyIf?.etag !== undefined && o?.etag !== onlyIf.etag) return null;
      const etag = `"${++n}"`;
      m.set(k, {bytes: bytes.slice(), etag});
      return {etag};
    },
  };
}
