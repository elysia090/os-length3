// The Remote's HTTP surface (Hono; the same app on Workers, in dev and in
// tests). /api/auth/* is Better Auth. Everything under /v1 but the release
// bundles needs a session, sent as a bearer token.
//
//   GET    /v1/about                  what this Remote offers: its sign-in providers
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
import {devOAuth} from './devoauth.ts';
import {inbox} from './inbox.ts';
import type {Bucket} from './bucket.ts';
import {blob, change, cut, home, offCode, passkeyProof, repo, review, type Tree} from './schema.ts';
import {user as people} from './schema.auth.ts';

export interface Deps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  auth: Auth;
  bucket: Bucket;
  /** Pages that may call: the web app, the desktop app's webview. */
  origins: string[];
  /** The providers offered for sign-in (auth.ts providers()). */
  providers: string[];
  /** Bytes of blobs one account may keep. */
  quota?: number;
  /** This Remote's own domain, for Inbox addresses (name@domain). */
  domain?: string;
  /** The Remote's own address (a domain's DNS record names its host). */
  baseURL?: string;
  /** The key Inbox domain proofs are made with (the service's secret). */
  secret?: string;
  /** TXT records of a name (DNS over HTTPS by default; a stand-in in tests). */
  txt?: (name: string) => Promise<string[]>;
}

/** What one account may keep, unless the deployment says otherwise. */
export const QUOTA = 2 * 1024 ** 3;

const HEX = /^[0-9a-f]{64}$/;
const LIMIT = {blob: 16 << 20, files: 20_000, diff: 5_000, words: 2_000, home: 1 << 20, log: 200};
const enc = new TextEncoder();

export async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const validName = (n: string) => /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(n);
/** A line of work: 'main', or an issue file's stem. */
export const validLine = (n: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n);

/**
 * Three trees as one, path by path: what changed on one side only is taken,
 * the same change on both is taken once, and a path both changed differently
 * is a conflict (and is left as `ours`).
 */
export function merge3(base: Tree, ours: Tree, theirs: Tree): {tree: Tree; conflicts: string[]} {
  const tree: Tree = {}, conflicts: string[] = [];
  const get = (t: Tree, p: string) => (p in t ? t[p] : undefined);
  for (const p of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
    const b = get(base, p), o = get(ours, p), t = get(theirs, p);
    const pick = o === t ? o : o === b ? t : t === b ? o : (conflicts.push(p), o);
    if (pick !== undefined) tree[p] = pick;
  }
  return {tree, conflicts: conflicts.sort()};
}

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

  app.get('/v1/about', (c) => c.json({passkey: true, providers: d.providers}));
  if (d.providers.includes('dev')) app.route('/dev-oauth', devOAuth());

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
    if (!s) return c.json({error: 'not signed in'}, 401);
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
    // An account holds its own work, up to its room: the Remote is no free store for anything else.
    const [{used}] = await d.db.select({used: sql<number>`coalesce(sum(${blob.size}), 0)`}).from(blob).where(eq(blob.userId, c.get('userId')));
    if (Number(used) + bytes.length > (d.quota ?? QUOTA)) return c.json({error: 'quota', used: Number(used), quota: d.quota ?? QUOTA}, 507);
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

  /** The line a request is about: ?line=, 'main' when not given. */
  const lineOf = (c: {req: {query(k: string): string | undefined}}) => c.req.query('line') ?? 'main';
  const at = (user: string, name: string, line: string) => and(eq(repo.userId, user), eq(repo.name, name), eq(repo.line, line));
  const lineRow = async (user: string, name: string, line: string) => (await d.db.select().from(repo).where(at(user, name, line)))[0] as typeof repo.$inferSelect | undefined;
  const cutRow = async (user: string, name: string, id: string | null) => (id ? (await d.db.select().from(cut).where(and(eq(cut.userId, user), eq(cut.repo, name), eq(cut.id, id))))[0] as typeof cut.$inferSelect | undefined : undefined);
  const treeAt = async (user: string, name: string, id: string | null): Promise<Tree> => (await cutRow(user, name, id))?.tree ?? {};
  const whoIs = async (c: {req: {raw: Request}}) => (await d.auth.api.getSession({headers: c.req.raw.headers}))?.user.name ?? '';

  // ---- turning a repo off: kept 30 days, back at once until then ----

  const KEPT = 30 * 24 * 3600 * 1000;
  /** The repo as it goes for good: every line, change and its history (blobs stay; other repos may share them). */
  const purge = async (user: string, name: string) => {
    await d.db.delete(change).where(and(eq(change.userId, user), eq(change.repo, name)));
    await d.db.delete(cut).where(and(eq(cut.userId, user), eq(cut.repo, name)));
    await d.db.delete(repo).where(and(eq(repo.userId, user), eq(repo.name, name)));
  };
  /** Proof the person is here: this request's session was made with a passkey within five minutes. */
  const proven = async (c: {get(k: 'sessionId'): string}) => {
    const [p] = await d.db.select().from(passkeyProof).where(eq(passkeyProof.sessionId, c.get('sessionId')));
    return !!p && Date.now() - p.at.getTime() < 5 * 60 * 1000;
  };
  const digestOf = async (user: string, code: string) => sha256(new TextEncoder().encode(`${user}:${code.toUpperCase()}`));
  const CODE = /^[A-Za-z0-9]{5}$/;

  // A repo that is off answers nothing but being off, and how to bring it back.
  const off: MiddlewareHandler<Vars> = async (c, next) => {
    const name = c.req.param('name');
    if (name && !c.req.path.endsWith('/on')) {
      const [main] = await d.db.select({offAt: repo.offAt}).from(repo).where(at(c.get('userId'), name, 'main'));
      if (main?.offAt) return c.json({error: 'off', offAt: main.offAt.getTime(), until: main.offAt.getTime() + KEPT}, 410);
    }
    await next();
  };
  v1.use('/repos/:name', off);
  v1.use('/repos/:name/*', off);

  // Repos are their main lines; one turned off shows when it goes for good.
  v1.get('/repos', async (c) => {
    const user = c.get('userId');
    const rows = await d.db.select({name: repo.name, head: repo.head, version: repo.version, bytes: repo.bytes, updatedAt: repo.updatedAt, offAt: repo.offAt})
      .from(repo).where(and(eq(repo.userId, user), eq(repo.line, 'main'))).orderBy(desc(repo.bytes));
    const out = [];
    for (const r of rows) {
      if (r.offAt && Date.now() - r.offAt.getTime() > KEPT) { await purge(user, r.name); continue; }
      out.push({...r, offAt: r.offAt?.getTime() ?? null, until: r.offAt ? r.offAt.getTime() + KEPT : null});
    }
    return c.json(out);
  });

  // Off: asks for a passkey just now, the account's name, the repo's name and the five-letter code.
  v1.post('/repos/:name/off', async (c) => {
    const user = c.get('userId'), name = c.req.param('name');
    const b = await c.req.json().catch(() => null) as {name?: unknown; repo?: unknown; code?: unknown} | null;
    if (!await proven(c)) return c.json({error: 'passkey'}, 403);
    const [me] = await d.db.select({name: people.name}).from(people).where(eq(people.id, user));
    const [kept] = await d.db.select().from(offCode).where(eq(offCode.userId, user));
    if (!kept) return c.json({error: 'no code'}, 409);
    const same = (a: unknown, b: string) => typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
    if (!same(b?.name, me?.name ?? '') || b?.repo !== name) return c.json({error: 'names'}, 403);
    if (typeof b?.code !== 'string' || !CODE.test(b.code) || await digestOf(user, b.code) !== kept.digest) return c.json({error: 'code'}, 403);
    const done = await d.db.update(repo).set({offAt: new Date()}).where(at(user, name, 'main')).returning({name: repo.name});
    if (!done.length) return c.json({error: 'no repo'}, 404);
    const offAt = Date.now();
    return c.json({name, offAt, until: offAt + KEPT});
  });

  // On: back at once, as it was.
  v1.post('/repos/:name/on', async (c) => {
    const done = await d.db.update(repo).set({offAt: null}).where(at(c.get('userId'), c.req.param('name'), 'main')).returning({name: repo.name});
    return done.length ? c.json({name: c.req.param('name'), on: true}) : c.json({error: 'no repo'}, 404);
  });

  // The code: whether one is set, and setting it (a passkey just now, as for turning off).
  v1.get('/off-code', async (c) => {
    const [kept] = await d.db.select({setAt: offCode.setAt}).from(offCode).where(eq(offCode.userId, c.get('userId')));
    return c.json({set: !!kept, setAt: kept?.setAt.getTime() ?? null});
  });
  v1.post('/off-code', async (c) => {
    const user = c.get('userId');
    const b = await c.req.json().catch(() => null) as {code?: unknown} | null;
    if (typeof b?.code !== 'string' || !CODE.test(b.code)) return c.json({error: 'five letters or digits'}, 400);
    if (!await proven(c)) return c.json({error: 'passkey'}, 403);
    const digest = await digestOf(user, b.code);
    await d.db.insert(offCode).values({userId: user, digest}).onConflictDoUpdate({target: offCode.userId, set: {digest, setAt: new Date()}});
    return c.json({set: true});
  });

  const lineShown = (row: typeof repo.$inferSelect) => ({name: row.name, line: row.line, issue: row.issue, head: row.head, pushed: row.pushed, base: row.base,
    draft: row.draft, version: row.version, bytes: row.bytes, startedBy: row.startedBy, startedAt: row.startedAt.getTime(), updatedAt: row.updatedAt});

  v1.get('/repos/:name', async (c) => {
    const row = await lineRow(c.get('userId'), c.req.param('name'), lineOf(c));
    return row ? c.json(lineShown(row)) : c.json({error: 'no repo'}, 404);
  });

  // A diff on a line's draft at `version`: the one mutable step besides a commit.
  v1.patch('/repos/:name/draft', async (c) => {
    const name = c.req.param('name'), line = lineOf(c);
    if (!validName(name) || !validLine(line)) return c.json({error: 'not found'}, 404);
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
    const row = await lineRow(user, name, line);
    // A line other than main is made by starting work on its issue, not by writing to it.
    if (!row && line !== 'main') return c.json({error: 'no such line'}, 404);
    const current = row?.version ?? 0;
    if (current !== body.version) return c.json({version: current, draft: row?.draft ?? {}}, 409);
    const tree: Tree = {...(row?.draft ?? {})};
    for (const p of remove as string[]) {
      delete tree[p];
      for (const q of Object.keys(tree)) if (q.startsWith(`${p}/`)) delete tree[q];
    }
    Object.assign(tree, set);
    if (Object.keys(tree).length > LIMIT.files) return c.json({error: 'too many files'}, 413);
    const bytes = await bytesOf(user, tree);
    const next = current + 1;
    const changed = row
      ? await d.db.update(repo).set({draft: tree, version: next, bytes, changedBy: c.get('sessionId'), updatedAt: new Date()})
        .where(and(at(user, name, line), eq(repo.version, current))).returning({version: repo.version})
      : await d.db.insert(repo).values({userId: user, name, line, draft: tree, version: next, bytes, changedBy: c.get('sessionId'), startedBy: await whoIs(c)})
        .onConflictDoNothing().returning({version: repo.version});
    // Another device changed it between the read and the write.
    if (!changed.length) {
      const now = await lineRow(user, name, line);
      return c.json({version: now?.version ?? 0, draft: now?.draft ?? {}}, 409);
    }
    return c.json({version: next, bytes});
  });

  const bytesOf = async (user: string, tree: Tree) => {
    const inTree = [...new Set(Object.values(tree).filter((v): v is string => typeof v === 'string'))];
    const sizes = inTree.length ? await d.db.select({size: blob.size}).from(blob).where(and(eq(blob.userId, user), inArray(blob.sha256, inTree))) : [];
    return sizes.reduce((n: number, r: {size: number}) => n + r.size, 0);
  };

  // Commit: a line's draft at `version` becomes the next commit after `parent`.
  v1.post('/repos/:name/cuts', async (c) => {
    const name = c.req.param('name'), line = lineOf(c);
    const user = c.get('userId');
    const b = await c.req.json().catch(() => null) as {version?: unknown; parent?: unknown; kind?: unknown; title?: unknown; issue?: unknown; note?: unknown; added?: unknown; removed?: unknown} | null;
    if (!b || typeof b.version !== 'number' || !(b.parent === null || (typeof b.parent === 'string' && HEX.test(b.parent)))) return c.json({error: 'a cut'}, 400);
    const words = {kind: b.kind ?? '', title: b.title, issue: b.issue ?? '', note: b.note ?? ''};
    for (const [k, v] of Object.entries(words)) if (typeof v !== 'string' || v.length > LIMIT.words) return c.json({error: k}, 400);
    if (!(words.title as string).trim()) return c.json({error: 'title'}, 400);
    const row = await lineRow(user, name, line);
    if (!row || row.version !== b.version || (row.head ?? null) !== b.parent) return c.json({head: row?.head ?? null, version: row?.version ?? 0}, 409);
    const made = await commit(user, name, line, row, {parent: b.parent as string | null, merged: null, tree: row.draft as Tree,
      ...(words as {kind: string; title: string; issue: string; note: string}), added: count(b.added), removed: count(b.removed)});
    return made ? c.json(made, 201) : c.json({head: row.head, version: row.version}, 409);
  });

  const count = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 2 ** 31 ? n : 0);

  /** Record a commit and move the line's head to it, from the head and version it was read at. */
  const commit = async (user: string, name: string, line: string, row: typeof repo.$inferSelect,
    w: {parent: string | null; merged: string | null; tree: Tree; kind: string; title: string; issue: string; note: string; added: number; removed: number},
    draft?: Tree) => {
    const time = Date.now();
    const id = await cutId({repo: `${name}${line === 'main' ? '' : `@${line}`}`, parent: w.parent, tree: w.tree, kind: w.kind, title: w.title, issue: w.issue, note: w.note, time});
    await d.db.insert(cut).values({id, userId: user, repo: name, line, parent: w.parent, merged: w.merged, tree: w.tree, kind: w.kind, title: w.title,
      issue: w.issue, note: w.note, added: w.added, removed: w.removed, time: new Date(time)}).onConflictDoNothing();
    const moved = await d.db.update(repo).set({head: id, draftBase: id, updatedAt: new Date(),
      ...(draft ? {draft, version: row.version + 1, bytes: await bytesOf(user, draft)} : {})})
      .where(and(at(user, name, line), eq(repo.version, row.version), w.parent === null ? sql`${repo.head} is null` : eq(repo.head, w.parent)))
      .returning({head: repo.head});
    return moved.length ? {id, time} : null;
  };

  v1.get('/repos/:name/cuts/:id', async (c) => {
    const row = await cutRow(c.get('userId'), c.req.param('name'), c.req.param('id'));
    return row ? c.json(shown(row)) : c.json({error: 'no cut'}, 404);
  });


  v1.get('/repos/:name/log', async (c) => {
    const limit = Math.min(LIMIT.log, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
    // As git log: from the line's head along first parents, so a work's history goes on into
    // main's from where it began, and every commit's parent is there to compare with.
    const user = c.get('userId'), name = c.req.param('name');
    const row = await lineRow(user, name, lineOf(c));
    if (!row?.head) return c.json([]);
    const all = await d.db.select().from(cut).where(and(eq(cut.userId, user), eq(cut.repo, name))).orderBy(desc(cut.time)).limit(LIMIT.log * 40);
    const byId = new Map<string, typeof cut.$inferSelect>(all.map((r: typeof cut.$inferSelect) => [r.id, r]));
    const out: (typeof cut.$inferSelect)[] = [];
    for (let id: string | null = row.head; id && out.length < limit;) {
      const r: typeof cut.$inferSelect | undefined = byId.get(id) ?? await cutRow(user, name, id);
      if (!r) break;
      out.push(r);
      id = r.parent;
    }
    return c.json(out.map(shown));
  });

  // ---- work on an issue: its own line, from main's last commit ----

  v1.get('/repos/:name/lines', async (c) => {
    const rows = await d.db.select().from(repo).where(and(eq(repo.userId, c.get('userId')), eq(repo.name, c.req.param('name'))));
    return c.json(rows.filter((r: typeof repo.$inferSelect) => r.line !== 'main').map(lineShown));
  });

  v1.post('/repos/:name/lines', async (c) => {
    const user = c.get('userId'), name = c.req.param('name');
    const b = await c.req.json().catch(() => null) as {issue?: unknown} | null;
    const issue = typeof b?.issue === 'string' ? b.issue : '';
    const stem = /^issue\/([A-Za-z0-9][A-Za-z0-9._-]{0,60})\.md$/.exec(issue)?.[1];
    if (!stem || !validLine(stem)) return c.json({error: 'an issue file, issue/NNN.md'}, 400);
    let main = await lineRow(user, name, 'main');
    if (!main) return c.json({error: 'no repo'}, 404);
    const existing = await lineRow(user, name, stem);
    if (existing) return c.json(lineShown(existing));
    // Work starts from what main last committed, not from main's uncommitted draft. A repo
    // nobody has committed yet gets its first commit (what it was made with) here, so the
    // work shows only what it changes.
    if (!main.head) {
      await commit(user, name, 'main', main, {parent: null, merged: null, tree: main.draft as Tree, kind: '', title: 'Start', issue: '', note: '', added: 0, removed: 0});
      main = (await lineRow(user, name, 'main'))!;
      if (!main.head) return c.json({error: 'main moved; try again'}, 409);
    }
    // The issue itself comes along when main has it written but not committed: the work is about it.
    const from = {...await treeAt(user, name, main.head)};
    const written = (main.draft as Tree)[issue];
    if (written && !from[issue]) from[issue] = written;
    await d.db.insert(repo).values({userId: user, name, line: stem, issue, base: main.head, head: main.head, pushed: main.head,
      draft: from, draftBase: main.head, version: 1, bytes: await bytesOf(user, from), startedBy: await whoIs(c)}).onConflictDoNothing();
    return c.json(lineShown((await lineRow(user, name, stem))!), 201);
  });

  // Push: the line's commits become visible as the line's state (what a change hands in).
  v1.post('/repos/:name/lines/:line/push', async (c) => {
    const user = c.get('userId'), name = c.req.param('name'), line = c.req.param('line');
    const b = await c.req.json().catch(() => null) as {head?: unknown} | null;
    const row = await lineRow(user, name, line);
    if (!row) return c.json({error: 'no such line'}, 404);
    if (b?.head !== row.head) return c.json({head: row.head}, 409);
    await d.db.update(repo).set({pushed: row.head, updatedAt: new Date()}).where(at(user, name, line));
    return c.json({pushed: row.head});
  });

  // ---- changes: a line handed to main ----

  const changeShown = async (row: typeof change.$inferSelect) => {
    const reviews = await d.db.select().from(review).where(eq(review.change, row.id)).orderBy(desc(review.time));
    return {...row, userId: undefined, createdAt: row.createdAt.getTime(), updatedAt: row.updatedAt.getTime(),
      reviews: reviews.map((r: typeof review.$inferSelect) => ({id: r.id, version: r.version, verdict: r.verdict, note: r.note, marks: r.marks, by: r.by, time: r.time.getTime()}))};
  };

  v1.get('/repos/:name/changes', async (c) => {
    const rows = await d.db.select().from(change).where(and(eq(change.userId, c.get('userId')), eq(change.repo, c.req.param('name')))).orderBy(desc(change.updatedAt));
    return c.json(await Promise.all(rows.map(changeShown)));
  });

  const changeRow = async (user: string, name: string, id: string) =>
    (await d.db.select().from(change).where(and(eq(change.userId, user), eq(change.repo, name), eq(change.id, id))))[0] as typeof change.$inferSelect | undefined;

  // Submit change: what the line has pushed, measured against main's last commit. Again after
  // more commits and a push, the same change gets a new version (and reviews of the old one are of the old one).
  v1.post('/repos/:name/changes', async (c) => {
    const user = c.get('userId'), name = c.req.param('name');
    const b = await c.req.json().catch(() => null) as {line?: unknown; kind?: unknown; title?: unknown; note?: unknown} | null;
    const line = typeof b?.line === 'string' ? b.line : '';
    const row = line && line !== 'main' ? await lineRow(user, name, line) : undefined;
    if (!row) return c.json({error: 'no such line'}, 404);
    if (!row.pushed || row.pushed !== row.head) return c.json({error: 'push first', head: row.head, pushed: row.pushed}, 409);
    if (row.pushed === row.base) return c.json({error: 'nothing committed since the work began'}, 409);
    const words = {kind: typeof b?.kind === 'string' ? b.kind : '', title: typeof b?.title === 'string' ? b.title.trim() : '', note: typeof b?.note === 'string' ? b.note : ''};
    if (!words.title || words.title.length > LIMIT.words || words.note.length > LIMIT.words) return c.json({error: 'title'}, 400);
    const [was] = await d.db.select().from(change).where(and(eq(change.userId, user), eq(change.repo, name), eq(change.line, line)));
    const by = await whoIs(c);
    if (was) {
      if (was.state === 'merged') return c.json({error: 'already merged'}, 409);
      const version = was.head === row.pushed && was.state === 'open' ? was.version : was.version + 1;
      await d.db.update(change).set({...words, head: row.pushed, base: row.base, version, state: 'open', submittedBy: by, updatedAt: new Date()}).where(eq(change.id, was.id));
      return c.json(await changeShown((await changeRow(user, name, was.id))!));
    }
    const id = crypto.randomUUID();
    await d.db.insert(change).values({id, userId: user, repo: name, line, issue: row.issue, ...words, head: row.pushed, base: row.base, submittedBy: by});
    return c.json(await changeShown((await changeRow(user, name, id))!), 201);
  });

  // Review: of one version; a newer push makes it a review of an older version, and says so.
  v1.post('/repos/:name/changes/:id/reviews', async (c) => {
    const user = c.get('userId'), row = await changeRow(user, c.req.param('name'), c.req.param('id'));
    if (!row) return c.json({error: 'no change'}, 404);
    const b = await c.req.json().catch(() => null) as {version?: unknown; verdict?: unknown; note?: unknown; marks?: unknown} | null;
    if (b?.version !== row.version) return c.json({version: row.version}, 409);
    if (!['approve', 'changes', 'comment'].includes(String(b?.verdict))) return c.json({error: 'verdict'}, 400);
    const note = typeof b?.note === 'string' ? b.note.slice(0, LIMIT.words) : '';
    // Lines marked in the diff, as "path:index" (the index of the line in that file's diff).
    const marks = Array.isArray(b?.marks) ? [...new Set((b!.marks as unknown[]).filter((m): m is string => typeof m === 'string' && m.length <= 600))].slice(0, 500) : [];
    await d.db.insert(review).values({id: crypto.randomUUID(), userId: user, change: row.id, version: row.version, verdict: String(b!.verdict), note, marks, by: await whoIs(c)});
    return c.json(await changeShown(row), 201);
  });

  // Merge: main takes the change, file by file against where the change began; a file both changed is a conflict.
  v1.post('/repos/:name/changes/:id/merge', async (c) => {
    const user = c.get('userId'), name = c.req.param('name'), row = await changeRow(user, name, c.req.param('id'));
    if (!row) return c.json({error: 'no change'}, 404);
    const b = await c.req.json().catch(() => null) as {version?: unknown} | null;
    if (row.state !== 'open') return c.json({error: row.state}, 409);
    if (b?.version !== row.version) return c.json({version: row.version}, 409);
    const main = await lineRow(user, name, 'main');
    if (!main) return c.json({error: 'no repo'}, 404);
    const [base, ours, theirs] = await Promise.all([treeAt(user, name, row.base), treeAt(user, name, main.head), treeAt(user, name, row.head)]);
    const merged = merge3(base, ours, theirs);
    if (merged.conflicts.length) return c.json({conflicts: merged.conflicts}, 409);
    // main's uncommitted draft keeps its own changes; what the merge brings is laid over it.
    const draft = merge3(ours, main.draft as Tree, merged.tree);
    if (draft.conflicts.length) return c.json({conflicts: draft.conflicts, draft: true}, 409);
    const made = await commit(user, name, 'main', main, {parent: main.head, merged: row.head, tree: merged.tree, kind: row.kind, title: row.title,
      issue: row.issue, note: row.note, added: 0, removed: 0}, draft.tree);
    if (!made) return c.json({error: 'main moved; try again'}, 409);
    await d.db.update(change).set({state: 'merged', mergedCut: made.id, updatedAt: new Date()}).where(eq(change.id, row.id));
    return c.json({merged: made.id, ...(await changeShown((await changeRow(user, name, row.id))!))});
  });

  // Reject (the receiver does not take it) and Reset (the one who submitted it takes it back).
  for (const [verb, state] of [['reject', 'rejected'], ['reset', 'reset']] as const) {
    v1.post(`/repos/:name/changes/:id/${verb}`, async (c) => {
      const user = c.get('userId'), name = c.req.param('name'), row = await changeRow(user, name, c.req.param('id'));
      if (!row) return c.json({error: 'no change'}, 404);
      if (row.state !== 'open') return c.json({error: row.state}, 409);
      const b = await c.req.json().catch(() => ({})) as {note?: unknown};
      await d.db.update(change).set({state, ...(typeof b.note === 'string' && b.note ? {note: b.note.slice(0, LIMIT.words)} : {}), updatedAt: new Date()}).where(eq(change.id, row.id));
      return c.json(await changeShown((await changeRow(user, name, row.id))!));
    });
  }

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

  inbox({db: d.db, domain: d.domain ?? 'length3.com', baseURL: d.baseURL ?? '', secret: d.secret ?? '', txt: d.txt}, v1, app);

  app.route('/v1', v1);
  return app;
}
