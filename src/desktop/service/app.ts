// The Remote's HTTP surface (Hono; the same app on Workers, in dev and in
// tests). /api/auth/* is Better Auth. Everything under /v1 but the release
// bundles needs a session, sent as a bearer token.
//
//   GET    /v1/about                  what this Remote offers (GitHub sign-in or not)
//   GET    /v1/os/:sha                a release bundle, to anyone, by digest (Range)
//   POST   /v1/blobs/missing [sha]    which of these the account does not have yet
//   PUT    /v1/blobs/:sha             bytes, refused unless they are that digest
//   GET    /v1/blobs/:sha
//   GET    /v1/repos                  each repo: head, draft version, bytes, when
//   GET    /v1/repos/:name            its draft (tree, version, base) and head
//   PATCH  /v1/repos/:name/draft      {version, set, remove}: a diff on that version
//                                      -> {version} | 409 {version, draft} | 409 {missing}
//   DELETE /v1/repos/:name            the repo and its history, from the Remote
//   POST   /v1/repos/:name/cuts       {version, parent, kind, title, issue, note, added, removed}:
//                                      the draft at that version becomes a cut
//   GET    /v1/repos/:name/cuts/:id
//   GET    /v1/repos/:name/log
//   GET    /v1/home/:key  PUT {value, version}

import {and, desc, eq, inArray, sql} from 'drizzle-orm';
import {Hono, type MiddlewareHandler} from 'hono';
import {cors} from 'hono/cors';
import type {Auth} from './auth.ts';
import type {Bucket} from './bucket.ts';
import {blob, cut, home, repo, type Tree} from './schema.ts';

export interface Deps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  auth: Auth;
  bucket: Bucket;
  /** Pages that may call: the web app, the desktop app's webview. */
  origins: string[];
  github: boolean;
}

const HEX = /^[0-9a-f]{64}$/;
const LIMIT = {blob: 16 << 20, files: 20_000, diff: 5_000, words: 2_000, home: 1 << 20, log: 200};
const enc = new TextEncoder();

export async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const validName = (n: string) => /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(n);

/** A repo path as the app allows one: no .., no empty part, never .git however spelt. */
export function validPath(p: string): boolean {
  if (!p || p.length > 1024 || p.startsWith('/')) return false;
  return p.split('/').every((part) => {
    if (!part || part === '.' || part === '..') return false;
    const n = part.replace(/[‌-‏‪-‮⁪-⁯﻿]/g, '').toLowerCase().replace(/[. ]+$/, '');
    return n !== '.git' && n !== 'git~1';
  });
}

/** A cut's id: the digest of what it records, in one fixed order. */
export async function cutId(c: {repo: string; parent: string | null; tree: Tree; kind: string; title: string; issue: string; note: string; time: number}) {
  const tree = Object.keys(c.tree).sort().map((p) => [p, c.tree[p]]);
  return sha256(enc.encode(JSON.stringify([c.repo, c.parent, tree, c.kind, c.title, c.issue, c.note, c.time])));
}

/** A cut as clients read it. */
const shown = ({userId: _, ...r}: typeof cut.$inferSelect) => ({...r, time: r.time.getTime()});

type Vars = {Variables: {userId: string; sessionId: string}};

export function createApp(d: Deps) {
  const app = new Hono<Vars>();
  app.use('*', cors({
    origin: (o) => (d.origins.includes(o) ? o : null),
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // The bearer plugin hands a new session's token back in this header.
    exposeHeaders: ['set-auth-token'],
    // A passkey's challenge is a cookie between asking and answering.
    credentials: true,
    maxAge: 600,
  }));
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
  });

  app.on(['GET', 'POST'], '/api/auth/*', (c) => d.auth.handler(c.req.raw));

  app.get('/v1/about', (c) => c.json({passkey: true, recovery: true, github: d.github}));

  // The OS is public: its canonical copy is the release, named by its digest.
  app.on(['GET', 'HEAD'], '/v1/os/:sha', async (c) => {
    const sha = c.req.param('sha');
    if (!HEX.test(sha)) return c.json({error: 'not found'}, 404);
    const m = /^bytes=(\d+)-(\d*)$/.exec(c.req.header('Range') ?? '');
    const start = m ? Number(m[1]) : 0;
    const o = await d.bucket.range(`os/${sha}`, start, m && m[2] ? Number(m[2]) : null);
    if (!o) return c.json({error: 'no release'}, 404);
    if (start >= o.size && o.size > 0) return new Response(null, {status: 416, headers: {'Content-Range': `bytes */${o.size}`}});
    const headers: Record<string, string> = {'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', ETag: `"${sha}"`, 'Content-Length': String(o.bytes.length)};
    if (m) headers['Content-Range'] = `bytes ${start}-${start + o.bytes.length - 1}/${o.size}`;
    return new Response(c.req.method === 'HEAD' ? null : o.bytes as BodyInit, {status: m ? 206 : 200, headers});
  });

  const signedIn: MiddlewareHandler<Vars> = async (c, next) => {
    const s = await d.auth.api.getSession({headers: c.req.raw.headers});
    if (!s) return c.json({error: 'サインインしていません'}, 401);
    c.set('userId', s.user.id);
    c.set('sessionId', s.session.id);
    await next();
  };
  const v1 = new Hono<Vars>();
  v1.use('*', signedIn);
  const key = (user: string, sha: string) => `u/${user}/${sha}`;

  v1.post('/blobs/missing', async (c) => {
    const list = await c.req.json().catch(() => null);
    if (!Array.isArray(list) || list.length > LIMIT.diff || !list.every((s) => typeof s === 'string' && HEX.test(s))) return c.json({error: 'a list of digests'}, 400);
    const wanted = [...new Set(list as string[])];
    if (!wanted.length) return c.json([]);
    const have = await d.db.select({sha: blob.sha256}).from(blob).where(and(eq(blob.userId, c.get('userId')), inArray(blob.sha256, wanted)));
    const got = new Set(have.map((r: {sha: string}) => r.sha));
    return c.json(wanted.filter((s) => !got.has(s)));
  });

  v1.put('/blobs/:sha', async (c) => {
    const sha = c.req.param('sha');
    if (!HEX.test(sha)) return c.json({error: 'not found'}, 404);
    if (Number(c.req.header('Content-Length') ?? 0) > LIMIT.blob) return c.json({error: 'too large'}, 413);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > LIMIT.blob) return c.json({error: 'too large'}, 413);
    if (await sha256(bytes) !== sha) return c.json({error: 'bytes are not that digest'}, 422);
    await d.bucket.put(key(c.get('userId'), sha), bytes);
    await d.db.insert(blob).values({userId: c.get('userId'), sha256: sha, size: bytes.length}).onConflictDoNothing();
    return c.json({sha256: sha}, 201);
  });

  v1.get('/blobs/:sha', async (c) => {
    const sha = c.req.param('sha');
    if (!HEX.test(sha)) return c.json({error: 'not found'}, 404);
    const known = await d.db.select({sha: blob.sha256}).from(blob).where(and(eq(blob.userId, c.get('userId')), eq(blob.sha256, sha)));
    const bytes = known.length ? await d.bucket.get(key(c.get('userId'), sha)) : null;
    return bytes ? new Response(bytes as BodyInit, {headers: {'Content-Type': 'application/octet-stream', ETag: `"${sha}"`}}) : c.json({error: 'no blob'}, 404);
  });

  v1.get('/repos', async (c) => {
    const rows = await d.db.select({name: repo.name, head: repo.head, version: repo.version, bytes: repo.bytes, updatedAt: repo.updatedAt})
      .from(repo).where(eq(repo.userId, c.get('userId'))).orderBy(desc(repo.bytes));
    return c.json(rows);
  });

  v1.get('/repos/:name', async (c) => {
    const [row] = await d.db.select().from(repo).where(and(eq(repo.userId, c.get('userId')), eq(repo.name, c.req.param('name'))));
    if (!row) return c.json({error: 'no repo'}, 404);
    return c.json({name: row.name, head: row.head, draft: row.draft, base: row.draftBase, version: row.version, bytes: row.bytes, updatedAt: row.updatedAt});
  });

  // A diff on the draft at `version`: the one mutable step besides a cut.
  v1.patch('/repos/:name/draft', async (c) => {
    const name = c.req.param('name');
    if (!validName(name)) return c.json({error: 'not found'}, 404);
    const body = await c.req.json().catch(() => null) as {version?: unknown; set?: unknown; remove?: unknown} | null;
    if (!body || typeof body.version !== 'number' || typeof body.set !== 'object' || body.set === null || !Array.isArray(body.remove)) return c.json({error: 'a diff'}, 400);
    const set = body.set as Record<string, unknown>;
    const remove = body.remove as unknown[];
    if (Object.keys(set).length + remove.length > LIMIT.diff) return c.json({error: 'too many changes at once'}, 413);
    for (const [p, v] of Object.entries(set)) if (!validPath(p) || !(v === null || (typeof v === 'string' && HEX.test(v)))) return c.json({error: `path ${p}`}, 400);
    for (const p of remove) if (typeof p !== 'string' || !validPath(p)) return c.json({error: `path ${String(p)}`}, 400);
    const user = c.get('userId');
    const shas = [...new Set(Object.values(set).filter((v): v is string => typeof v === 'string'))];
    if (shas.length) {
      const have = await d.db.select({sha: blob.sha256}).from(blob).where(and(eq(blob.userId, user), inArray(blob.sha256, shas)));
      const got = new Set(have.map((r: {sha: string}) => r.sha));
      const missing = shas.filter((s) => !got.has(s));
      if (missing.length) return c.json({missing}, 409);
    }
    const [row] = await d.db.select().from(repo).where(and(eq(repo.userId, user), eq(repo.name, name)));
    const current = row?.version ?? 0;
    if (current !== body.version) return c.json({version: current, draft: row?.draft ?? {}}, 409);
    const tree: Tree = {...(row?.draft ?? {})};
    for (const p of remove as string[]) {
      delete tree[p];
      for (const q of Object.keys(tree)) if (q.startsWith(`${p}/`)) delete tree[q];
    }
    Object.assign(tree, set);
    if (Object.keys(tree).length > LIMIT.files) return c.json({error: 'too many files'}, 413);
    const inTree = [...new Set(Object.values(tree).filter((v): v is string => typeof v === 'string'))];
    const sizes = inTree.length ? await d.db.select({size: blob.size}).from(blob).where(and(eq(blob.userId, user), inArray(blob.sha256, inTree))) : [];
    const bytes = sizes.reduce((n: number, r: {size: number}) => n + r.size, 0);
    const next = current + 1;
    const changed = row
      ? await d.db.update(repo).set({draft: tree, version: next, bytes, changedBy: c.get('sessionId'), updatedAt: new Date()})
        .where(and(eq(repo.userId, user), eq(repo.name, name), eq(repo.version, current))).returning({version: repo.version})
      : await d.db.insert(repo).values({userId: user, name, draft: tree, version: next, bytes, changedBy: c.get('sessionId')})
        .onConflictDoNothing().returning({version: repo.version});
    // Another device changed it between the read and the write.
    if (!changed.length) {
      const [now] = await d.db.select().from(repo).where(and(eq(repo.userId, user), eq(repo.name, name)));
      return c.json({version: now?.version ?? 0, draft: now?.draft ?? {}}, 409);
    }
    return c.json({version: next, bytes});
  });

  // 区切る: the draft at `version` becomes the next cut after `parent`.
  v1.post('/repos/:name/cuts', async (c) => {
    const name = c.req.param('name');
    const user = c.get('userId');
    const b = await c.req.json().catch(() => null) as {version?: unknown; parent?: unknown; kind?: unknown; title?: unknown; issue?: unknown; note?: unknown; added?: unknown; removed?: unknown} | null;
    if (!b || typeof b.version !== 'number' || !(b.parent === null || (typeof b.parent === 'string' && HEX.test(b.parent)))) return c.json({error: 'a cut'}, 400);
    const words = {kind: b.kind ?? '', title: b.title, issue: b.issue ?? '', note: b.note ?? ''};
    for (const [k, v] of Object.entries(words)) if (typeof v !== 'string' || v.length > LIMIT.words) return c.json({error: k}, 400);
    if (!(words.title as string).trim()) return c.json({error: 'title'}, 400);
    const count = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 2 ** 31 ? n : 0);
    const [row] = await d.db.select().from(repo).where(and(eq(repo.userId, user), eq(repo.name, name)));
    if (!row || row.version !== b.version || (row.head ?? null) !== b.parent) return c.json({head: row?.head ?? null, version: row?.version ?? 0}, 409);
    const record = {repo: name, parent: b.parent as string | null, tree: row.draft as Tree, ...(words as {kind: string; title: string; issue: string; note: string}), time: Date.now()};
    const id = await cutId(record);
    await d.db.insert(cut).values({id, userId: user, repo: name, parent: record.parent, tree: record.tree, kind: record.kind, title: record.title, issue: record.issue, note: record.note,
      added: count(b.added), removed: count(b.removed), time: new Date(record.time)}).onConflictDoNothing();
    const moved = await d.db.update(repo).set({head: id, draftBase: id, updatedAt: new Date()})
      .where(and(eq(repo.userId, user), eq(repo.name, name), eq(repo.version, row.version), b.parent === null ? sql`${repo.head} is null` : eq(repo.head, b.parent as string)))
      .returning({head: repo.head});
    if (!moved.length) return c.json({head: row.head, version: row.version}, 409);
    return c.json({id, time: record.time}, 201);
  });

  v1.get('/repos/:name/cuts/:id', async (c) => {
    const [row] = await d.db.select().from(cut).where(and(eq(cut.userId, c.get('userId')), eq(cut.repo, c.req.param('name')), eq(cut.id, c.req.param('id'))));
    return row ? c.json(shown(row)) : c.json({error: 'no cut'}, 404);
  });

  // The repo goes from the Remote with its history; blobs stay (other repos may share them).
  v1.delete('/repos/:name', async (c) => {
    const user = c.get('userId'), name = c.req.param('name');
    await d.db.delete(cut).where(and(eq(cut.userId, user), eq(cut.repo, name)));
    const gone = await d.db.delete(repo).where(and(eq(repo.userId, user), eq(repo.name, name))).returning({name: repo.name});
    return gone.length ? c.json({removed: name}) : c.json({error: 'no repo'}, 404);
  });

  v1.get('/repos/:name/log', async (c) => {
    const limit = Math.min(LIMIT.log, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
    const rows = await d.db.select().from(cut).where(and(eq(cut.userId, c.get('userId')), eq(cut.repo, c.req.param('name')))).orderBy(desc(cut.time)).limit(limit);
    return c.json(rows.map(shown));
  });

  v1.get('/home/:key', async (c) => {
    const [row] = await d.db.select().from(home).where(and(eq(home.userId, c.get('userId')), eq(home.key, c.req.param('key'))));
    return row ? c.json({value: row.value, version: row.version}) : c.json({value: null, version: 0});
  });

  v1.put('/home/:key', async (c) => {
    const k = c.req.param('key');
    if (!/^[a-z]{1,32}$/.test(k)) return c.json({error: 'not found'}, 404);
    const b = await c.req.json().catch(() => null) as {value?: unknown; version?: unknown} | null;
    if (!b || typeof b.value !== 'string' || typeof b.version !== 'number' || b.value.length > LIMIT.home) return c.json({error: 'a value and its version'}, 400);
    const user = c.get('userId');
    const done = b.version === 0
      ? await d.db.insert(home).values({userId: user, key: k, value: b.value, version: 1}).onConflictDoNothing().returning({version: home.version})
      : await d.db.update(home).set({value: b.value, version: b.version + 1, updatedAt: new Date()})
        .where(and(eq(home.userId, user), eq(home.key, k), eq(home.version, b.version))).returning({version: home.version});
    if (!done.length) {
      const [row] = await d.db.select().from(home).where(and(eq(home.userId, user), eq(home.key, k)));
      return c.json({value: row?.value ?? null, version: row?.version ?? 0}, 409);
    }
    return c.json({version: done[0].version});
  });

  app.route('/v1', v1);
  return app;
}
