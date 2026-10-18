// Repos kept: the canonical copy of each of an account's repos (DESIGN.md
// §6, "The canonical copy is on the Remote"). A repo is lines of work, main
// and one per issue; each line a draft (the working tree, path -> digest,
// versioned), a head (its last commit) and what it pushed. Rows only: the
// files a tree names are blobs (files.ts).
//
//   GET    /v1/moved                  what moved, cheaply: {repos: stamp, home: {key: version}}
//   GET    /v1/repos                  each repo: head, draft version, bytes, when
//   GET    /v1/repos/gone             each repo that went for good, lately: [{name, at}]
//   GET    /v1/repos/:name            a line's draft (tree, version, base) and head (?line=, main by default)
//                                      -> 404 {gone} when it went for good
//   PATCH  /v1/repos/:name/draft      {version, set, remove}: a diff on that version
//                                      -> {version} | 409 {version} | 409 {missing}
//                                      | 410 {gone} for a name that went, unless ?anew=1 makes it again
//   POST   /v1/repos/:name/cuts       {version, parent, kind, title, issue, note, added, removed}:
//                                      the draft at that version becomes a cut
//   GET    /v1/repos/:name/cuts/:id
//   GET    /v1/repos/:name/log        from the line's head along first parents
//   POST   /v1/repos/:name/off | on   off: a passkey just now, the names and the code; on: back at once
//   POST   /v1/repos/:name/discard    an off repo goes for good, now (asked as off is)
//   GET    /v1/off-code  POST {code}
//   GET    /v1/repos/:name/lines      the work on its issues; POST {issue} starts one
//   POST   /v1/repos/:name/lines/:line/push {head}
//   GET    /v1/repos/:name/changes    POST {line, kind, title, note}: Submit change
//   POST   /v1/repos/:name/changes/:id/reviews | merge | reject | reset
//
// Every write that is checked against what the account already has (its
// room, how many repos or lines) holds the account's lock in a transaction,
// so the check and the write are one step. What goes, goes as sweep.ts lets
// it go: discarding a repo is its purge, run at once.
//
// A repo is found by its owner and name (repoAt, lineAt); everything after
// that is by its number, which the rows under it carry.

import {and, desc, eq, inArray, isNull, ne, sql} from 'drizzle-orm';
import type {Context, Hono} from 'hono';
import type {Plans} from './plan.ts';
import {ago, body, fits as fitsIn, HEX, LIMIT, lock, ms, qualified, refuse, rows, sha256, type Db, type Vars} from './request.ts';
import {blob, change, cut, guard, line, repo, repoGone, review, throttle, type Review, type Tree} from './schema.ts';
import {KEPT, purge, REMEMBERED} from './sweep.ts';

const enc = new TextEncoder();

export const validName = (n: string) => /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(n);
/** A line of work: 'main', or an issue file's stem. */
export const validLine = (n: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n);
/** The issue a line is the work for: its file ('issue/001.md'); '' for main. */
export const issueOf = (line: string) => (line === 'main' ? '' : `issue/${line}.md`);

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

/** A draft with a diff laid on it: `remove` takes a path and everything under it, then `set` is written. */
export function applyDiff(draft: Tree, set: Tree, remove: string[]): Tree {
  const gone = new Set(remove);
  // A path goes when it, or a folder it is in, was removed: its own ancestors are looked up, not every path removed.
  const removed = (p: string) => {
    for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) if (gone.has(p.slice(0, i))) return true;
    return gone.has(p);
  };
  const tree: Tree = {};
  for (const [p, v] of Object.entries(draft)) if (!gone.size || !removed(p)) tree[p] = v;
  return Object.assign(tree, set);
}

/** A cut's id: the digest of what it records, in one fixed order. */
export async function cutId(c: {repo: string; parent: string | null; tree: Tree; kind: string; title: string; issue: string; note: string; time: number}) {
  const tree = Object.keys(c.tree).sort().map((p) => [p, c.tree[p]]);
  return sha256(enc.encode(JSON.stringify([c.repo, c.parent, tree, c.kind, c.title, c.issue, c.note, c.time])));
}

/** A commit as clients read it. */
const cutCols = {id: cut.id, parent: cut.parent, merged: cut.merged, tree: cut.tree, kind: cut.kind, title: cut.title, issue: cut.issue,
  note: cut.note, added: cut.added, removed: cut.removed, time: cut.time};
/** A line as clients read it: `name` is its repo's, `line` its own; `id` (its repo's number) and `off` are the service's. */
const lineCols = {id: repo.id, off: repo.offAt, name: repo.name, line: line.name, base: line.base, head: line.head, pushed: line.pushed,
  version: line.version, startedBy: line.startedBy, startedAt: line.startedAt, updatedAt: line.updatedAt};
/** A change as clients read it, its reviews newest first. */
const changeCols = {id: change.id, line: change.line, kind: change.kind, title: change.title, version: change.version, base: change.base,
  head: change.head, state: change.state, note: change.note, submittedBy: change.submittedBy, updatedAt: change.updatedAt,
  reviews: sql<Review[]>`coalesce((select jsonb_agg(jsonb_build_object('version', r.version, 'verdict', r.verdict, 'note', r.note, 'marks', r.marks,
    'by', r.by, 'time', ${ms(sql`r.time`)}) order by r.time desc, r.id) from review r where r.change_id = ${qualified(change.id)}), '[]'::jsonb)`.as('reviews')};
type Line = {id: number; off: Date | null; name: string; line: string; base: string | null; head: string | null; pushed: string | null; version: number;
  startedBy: string; startedAt: Date; updatedAt: Date; draft?: Tree};
type Change = {id: string; line: string; kind: string; title: string; version: number; base: string | null; head: string;
  state: string; note: string; submittedBy: string; reviews: Review[]; updatedAt: Date};

const lineShown = ({id: _, off: __, draft, ...r}: Line) => ({...r, issue: issueOf(r.line), ...(draft ? {draft} : {}), startedAt: r.startedAt.getTime()});
const changeShown = (repoName: string, {repoId: _, off: __, ...r}: Change & {repoId?: number; off?: Date | null}) =>
  ({...r, repo: repoName, issue: issueOf(r.line), updatedAt: r.updatedAt.getTime()});
const count = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 2 ** 31 ? n : 0);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function repos(d: {db: Db; quota?: number; plans: Plans}, v1: Hono<Vars>) {
  const db = d.db;
  const fits = (q: Db, user: string, more: number) => fitsIn(q, user, more, d.quota);

  // ---- what moved: the one request a page asks every few seconds ----

  // The room's stamp, which moves whenever GET /v1/repos or /v1/repos/gone would read differently
  // (0001's triggers), and each setting's version: one row and a few small ones.
  v1.get('/moved', async (c) => {
    const [m] = await rows<{repos: string; home: Record<string, number>}>(db, sql`select r.stamp::text as repos,
      (select coalesce(jsonb_object_agg(h.key, h.version), '{}'::jsonb) from home h where h.user_id = r.user_id) as home
      from room r where r.user_id = ${c.get('userId')}`);
    return c.json(m ?? {repos: '0', home: {}});
  });

  // ---- repos and their lines ----

  /** The line a request is about: ?line=, 'main' when not given. */
  const lineOf = (c: {req: {query(k: string): string | undefined}}) => c.req.query('line') ?? 'main';
  /** `user`'s repo `name`: its number, and whether it is off. */
  const repoAt = async (q: Db, user: string, name: string) =>
    (await q.select({id: repo.id, off: repo.offAt}).from(repo).where(and(eq(repo.userId, user), eq(repo.name, name))))[0] as {id: number; off: Date | null} | undefined;
  /** A line (with its draft only when asked for), its repo's number, and whether its repo is off: one read. */
  const lineAt = async (q: Db, user: string, name: string, l: string, draft = false): Promise<Line | undefined> =>
    (await q.select({...lineCols, ...(draft ? {draft: line.draft} : {})}).from(line).innerJoin(repo, eq(repo.id, line.repoId))
      .where(and(eq(repo.userId, user), eq(repo.name, name), eq(line.name, l))))[0];
  /** The row of line `l` of repo `id`. */
  const lineRow = (id: number, l: string) => and(eq(line.repoId, id), eq(line.name, l));
  /** A repo that is off answers nothing but being off, and until when it can come back. */
  const on = (off: Date | null | undefined) => { if (off) refuse(410, {error: 'This repo is turned off', offAt: off.getTime(), until: off.getTime() + KEPT}); };
  /** The names that went for good and are still remembered, each with when (sweep.ts purge). */
  const remembered = (user: string) => and(eq(repoGone.userId, user), sql`${repoGone.at} > ${ago(REMEMBERED)}`);
  /** When `name` went for good, if it did lately. */
  const goneAt = async (q: Db, user: string, name: string) =>
    ((await q.select({at: repoGone.at}).from(repoGone).where(and(remembered(user), eq(repoGone.name, name))))[0] as {at: Date} | undefined)?.at.getTime();
  /** The trees of the commits `ids` of repo `id`; one not there is empty. */
  const treesOf = async (q: Db, id: number, ids: (string | null)[]) => {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    const found = wanted.length ? await q.select({id: cut.id, tree: cut.tree}).from(cut).where(and(eq(cut.repoId, id), inArray(cut.id, wanted))) : [];
    const by = new Map<string, Tree>(found.map((r: {id: string; tree: Tree}) => [r.id, r.tree]));
    return (c: string | null): Tree => (c && by.get(c)) || {};
  };

  // Repos are their main lines; one turned off says when it goes for good.
  v1.get('/repos', async (c) => {
    const list = await db.select({name: repo.name, head: line.head, version: line.version, updatedAt: line.updatedAt, offAt: repo.offAt, bytes: line.fileBytes})
      .from(repo).innerJoin(line, and(eq(line.repoId, repo.id), eq(line.name, 'main'))).where(eq(repo.userId, c.get('userId')))
      .orderBy(desc(line.fileBytes), repo.name) as {offAt: Date | null}[];
    return c.json(list.map((r) => ({...r, offAt: r.offAt?.getTime() ?? null, until: r.offAt ? r.offAt.getTime() + KEPT : null})));
  });

  // The repos that went for good lately, newest first: a device holding a copy of one is told so.
  // Its own word, so no repo may be named it (PATCH draft).
  v1.get('/repos/gone', async (c) => {
    const list = await db.select({name: repoGone.name, at: repoGone.at}).from(repoGone).where(remembered(c.get('userId')))
      .orderBy(desc(repoGone.at), repoGone.name) as {name: string; at: Date}[];
    return c.json(list.map((r) => ({name: r.name, at: r.at.getTime()})));
  });

  v1.get('/repos/:name', async (c) => {
    const user = c.get('userId'), name = c.req.param('name');
    const row = await lineAt(db, user, name, lineOf(c), true);
    if (!row) {
      const gone = await goneAt(db, user, name);
      return c.json({error: 'That repo is not on the Remote', ...(gone ? {gone} : {})}, 404);
    }
    on(row.off);
    return c.json(lineShown(row));
  });

  // A diff on a line's draft at `version`: the one mutable step besides a commit. The first makes
  // the repo; under a name that went for good, only when asked as new (?anew=1): a client asks so
  // exactly when its copy was never in step with the Remote, so a copy that was cannot bring back
  // what was discarded by sending itself again.
  v1.patch('/repos/:name/draft', async (c) => {
    const user = c.get('userId'), name = c.req.param('name'), l = lineOf(c), anew = c.req.query('anew') === '1';
    if (!validName(name) || !validLine(l)) return c.json({error: 'Not found'}, 404);
    const b = await body<{version?: unknown; set?: unknown; remove?: unknown}>(c);
    if (!b || typeof b.version !== 'number' || typeof b.set !== 'object' || b.set === null || Array.isArray(b.set) || !Array.isArray(b.remove)) return c.json({error: 'a diff'}, 400);
    const set = b.set as Record<string, unknown>, remove = b.remove as unknown[];
    if (Object.keys(set).length + remove.length > LIMIT.diff) return c.json({error: 'Too many changes at once'}, 413);
    for (const [p, v] of Object.entries(set)) if (!validPath(p) || !(v === null || (typeof v === 'string' && HEX.test(v)))) return c.json({error: 'A path no repo may have', path: p}, 400);
    for (const p of remove) if (typeof p !== 'string' || !validPath(p)) return c.json({error: 'A path no repo may have', path: String(p)}, 400);
    const shas = [...new Set(Object.values(set).filter((v): v is string => typeof v === 'string'))];
    const version = await db.transaction(async (tx: Db) => {
      await lock(tx, user);
      const row = await lineAt(tx, user, name, l, true);
      on(row?.off);
      if (!row) {
        const gone = await goneAt(tx, user, name);
        if (gone && !(anew && l === 'main')) refuse(410, {error: 'This repo was discarded on the Remote.', gone});
        // A line other than main is made by starting work on its issue, not by writing to it.
        if (l !== 'main') refuse(404, {error: 'That work is not on the Remote'});
        if (name === 'gone') refuse(400, {error: 'A repo cannot be called gone'});
      }
      if (shas.length) {
        const have = new Set((await tx.select({sha: blob.sha256}).from(blob).where(and(eq(blob.userId, user), inArray(blob.sha256, shas)))).map((r: {sha: string}) => r.sha));
        const missing = shas.filter((s) => !have.has(s));
        if (missing.length) refuse(409, {missing});
      }
      const current = row?.version ?? 0;
      if (current !== b.version) refuse(409, {version: current});
      const was = row?.draft ?? {};
      const tree = applyDiff(was, set as Tree, remove as string[]);
      const size = JSON.stringify(tree).length;
      if (Object.keys(tree).length > LIMIT.files || size > LIMIT.tree) refuse(413, {error: 'Too many files for one repo'});
      if (!row) {
        const [{n}] = await tx.select({n: sql<number>`count(*)::int`}).from(repo).where(eq(repo.userId, user));
        if (n >= LIMIT.repos) refuse(429, {error: 'Too many repos'});
        await d.plans.newRepo(tx, user);
      }
      await fits(tx, user, size - JSON.stringify(was).length);
      // What the draft takes (its tree and its files, each blob once) before and after: the plan refuses one
      // that grew while the account keeps more than it allows, and the whole change is undone with it.
      const kept = {bytes: line.bytes, files: line.fileBytes};
      const [before] = row ? await tx.select(kept).from(line).where(lineRow(row.id, l)) as {bytes: number; files: number}[] : [{bytes: 0, files: 0}];
      let after: {bytes: number; files: number}[];
      if (row) after = await tx.update(line).set({draft: tree, version: current + 1, updatedAt: sql`now()`}).where(and(lineRow(row.id, l), eq(line.version, current))).returning(kept);
      else {
        await tx.delete(repoGone).where(and(eq(repoGone.userId, user), eq(repoGone.name, name)));
        const [made] = await tx.insert(repo).values({userId: user, name}).returning({id: repo.id}) as {id: number}[];
        after = await tx.insert(line).values({repoId: made.id, userId: user, name: 'main', draft: tree, version: 1, startedBy: c.get('name')}).returning(kept);
      }
      if (after[0]) await d.plans.grew(tx, user, Number(after[0].bytes) + Number(after[0].files) - Number(before.bytes) - Number(before.files));
      return current + 1;
    });
    return c.json({version});
  });

  /**
   * Record a commit on a line read at `row` (its head is the parent) and move the head to it; with
   * `draft`, the draft is laid down too. The commit is there before the line names it. The caller
   * holds the account's lock in a transaction: refused, neither stays.
   */
  const commit = async (tx: Db, user: string, row: Line,
    w: {merged: string | null; tree: Tree; kind: string; title: string; issue: string; note: string; added: number; removed: number}, draft?: Tree) => {
    await fits(tx, user, JSON.stringify(w.tree).length);
    const time = Date.now();
    const id = await cutId({repo: `${row.name}${row.line === 'main' ? '' : `@${row.line}`}`, parent: row.head, tree: w.tree, kind: w.kind, title: w.title, issue: w.issue, note: w.note, time});
    await tx.insert(cut).values({repoId: row.id, id, userId: user, parent: row.head, merged: w.merged, tree: w.tree, kind: w.kind, title: w.title,
      issue: w.issue, note: w.note, added: w.added, removed: w.removed, time: new Date(time)}).onConflictDoNothing();
    const moved = await tx.update(line).set({head: id, updatedAt: sql`now()`, ...(draft ? {draft, version: row.version + 1} : {})})
      .where(and(lineRow(row.id, row.line), eq(line.version, row.version), row.head === null ? isNull(line.head) : eq(line.head, row.head))).returning({head: line.head});
    if (!moved.length) refuse(409, {head: row.head, version: row.version});
    return {id, time};
  };

  // Commit: a line's draft at `version` becomes the next commit after `parent`.
  v1.post('/repos/:name/cuts', async (c) => {
    const user = c.get('userId'), name = c.req.param('name'), l = lineOf(c);
    const b = await body<{version?: unknown; parent?: unknown; kind?: unknown; title?: unknown; issue?: unknown; note?: unknown; added?: unknown; removed?: unknown}>(c);
    if (!b || typeof b.version !== 'number' || !(b.parent === null || (typeof b.parent === 'string' && HEX.test(b.parent)))) return c.json({error: 'a cut'}, 400);
    const words = {kind: b.kind ?? '', title: b.title, issue: b.issue ?? '', note: b.note ?? ''};
    for (const v of Object.values(words)) if (typeof v !== 'string' || v.length > LIMIT.words) return c.json({error: 'Words of at most 2000 characters'}, 400);
    if (!(words.title as string).trim()) return c.json({error: 'A commit needs a title'}, 400);
    const made = await db.transaction(async (tx: Db) => {
      await lock(tx, user);
      const row = await lineAt(tx, user, name, l, true);
      on(row?.off);
      if (!row || row.version !== b.version || row.head !== b.parent) refuse(409, {head: row?.head ?? null, version: row?.version ?? 0});
      return commit(tx, user, row, {merged: null, tree: row.draft!, ...(words as {kind: string; title: string; issue: string; note: string}),
        added: count(b.added), removed: count(b.removed)});
    });
    return c.json(made, 201);
  });

  v1.get('/repos/:name/cuts/:id', async (c) => {
    const id = c.req.param('id');
    if (!HEX.test(id)) return c.json({error: 'No such commit'}, 404);
    const [row] = await db.select({...cutCols, off: repo.offAt}).from(cut).innerJoin(repo, eq(repo.id, cut.repoId))
      .where(and(eq(repo.userId, c.get('userId')), eq(repo.name, c.req.param('name')), eq(cut.id, id)));
    if (!row) return c.json({error: 'No such commit'}, 404);
    on(row.off);
    const {off: _, ...shown} = row;
    return c.json({...shown, time: row.time.getTime()});
  });

  // As git log: from the line's head along first parents, so a work's history goes on into main's
  // from where it began, and every commit's parent is there to compare with. One walk in the database,
  // each step one lookup of the repo's commits by their key.
  v1.get('/repos/:name/log', async (c) => {
    const limit = Math.min(LIMIT.log, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
    const row = await lineAt(db, c.get('userId'), c.req.param('name'), lineOf(c));
    on(row?.off);
    if (!row?.head) return c.json([]);
    return c.json(await rows(db, sql`with recursive walk(id, n) as (
        select ${row.head}::text, 1
        union all
        select c.parent, w.n + 1 from walk w join cut c on c.repo_id = ${row.id} and c.id = w.id
        where c.parent is not null and w.n < ${limit}
      )
      select c.id, c.parent, c.merged, c.tree, c.kind, c.title, c.issue, c.note, c.added, c.removed, ${ms(sql`c.time`)} as time
      from walk w join cut c on c.repo_id = ${row.id} and c.id = w.id order by w.n`));
  });

  // ---- turning a repo off: kept 30 days, back at once until then, or discarded now ----

  const digestOf = async (user: string, code: string) => sha256(enc.encode(`${user}:${code.toUpperCase()}`));
  const CODE = /^[A-Za-z0-9]{5}$/;
  /** Wrong codes an account may give an hour. */
  const OFF_TRIES = 10;
  /** Proof the person is here: this request's session is the account's latest passkey sign-in, within five minutes. */
  const proven = (g: typeof guard.$inferSelect | undefined, sessionId: string) =>
    !!g?.proofAt && g.proofSession === sessionId && Date.now() - g.proofAt.getTime() < 5 * 60 * 1000;
  /**
   * What turning a repo off asks, and discarding it: a passkey just now, the account's name, the
   * repo's name and the five-letter code, sent as {name, repo, code}. Refused (403, 409) unless all are so.
   */
  const confirmed = async (c: Context<Vars>, name: string) => {
    const user = c.get('userId');
    const b = await body<{name?: unknown; repo?: unknown; code?: unknown}>(c);
    const [g] = await db.select().from(guard).where(eq(guard.userId, user)) as (typeof guard.$inferSelect)[];
    if (!proven(g, c.get('sessionId'))) refuse(403, {error: 'Confirm with a passkey.'});
    if (!g.offDigest) refuse(409, {error: 'Set the five-letter code under Sign-in first.'});
    const same = (a: unknown, b: string) => typeof a === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();
    if (!same(b?.name, c.get('name')) || b?.repo !== name) refuse(403, {error: 'The names do not match.'});
    const right = typeof b?.code === 'string' && CODE.test(b.code) && await digestOf(user, b.code) === g.offDigest;
    // Wrong codes are counted, and past so many an hour none is taken, the right one neither: the code is not found by trying.
    const key = `off-code:${user}`;
    const wrong = await db.transaction(async (tx: Db) => {
      await lock(tx, key);
      const [r] = await rows<{n: number}>(tx, sql`select count(*)::int as n from throttle where key = ${key} and at > ${ago(3600_000)}`);
      if (!right && r.n < OFF_TRIES) await tx.insert(throttle).values({key});
      return r.n;
    });
    if (wrong >= OFF_TRIES) refuse(429, {error: 'Too many wrong codes; try again in an hour'});
    if (!right) refuse(403, {error: 'That is not the code.'});
  };
  const named = (user: string, name: string) => and(eq(repo.userId, user), eq(repo.name, name));

  // Off: asks for a passkey just now, the account's name, the repo's name and the five-letter code.
  v1.post('/repos/:name/off', async (c) => {
    const user = c.get('userId'), name = c.req.param('name');
    await confirmed(c, name);
    // Off once: asking again does not restart its 30 days.
    const [done] = await db.update(repo).set({offAt: sql`coalesce(${repo.offAt}, now())`}).where(named(user, name)).returning({offAt: repo.offAt});
    if (!done) return c.json({error: 'That repo is not on the Remote'}, 404);
    return c.json({name, offAt: done.offAt.getTime(), until: done.offAt.getTime() + KEPT});
  });

  // Discard: a repo turned off goes for good now, as the sweep lets one go after its 30 days
  // (sweep.ts purge), asked for as turning it off is. Its name is remembered as gone.
  v1.post('/repos/:name/discard', async (c) => {
    const user = c.get('userId'), name = c.req.param('name');
    await confirmed(c, name);
    await db.transaction(async (tx: Db) => {
      await lock(tx, user);
      if ((await purge(tx, sql`r.user_id = ${user} and r.name = ${name}`)).repo) return;
      // Nothing went: it is on (perhaps turned on just now), or not there at all.
      if (await repoAt(tx, user, name)) refuse(409, {error: 'Turn it off first.'});
      refuse(404, {error: 'That repo is not on the Remote'});
    });
    return c.json({name, discarded: true});
  });

  // On: back at once, as it was.
  v1.post('/repos/:name/on', async (c) => {
    const done = await db.update(repo).set({offAt: null}).where(named(c.get('userId'), c.req.param('name'))).returning({id: repo.id});
    return done.length ? c.json({name: c.req.param('name'), on: true}) : c.json({error: 'That repo is not on the Remote'}, 404);
  });

  // The code: whether one is set, and setting it (a passkey just now, as for turning off).
  v1.get('/off-code', async (c) => {
    const [g] = await db.select({setAt: guard.offSetAt}).from(guard).where(and(eq(guard.userId, c.get('userId')), sql`${guard.offDigest} is not null`));
    return c.json({set: !!g, setAt: g?.setAt?.getTime() ?? null});
  });
  v1.post('/off-code', async (c) => {
    const user = c.get('userId');
    const b = await body<{code?: unknown}>(c);
    if (typeof b?.code !== 'string' || !CODE.test(b.code)) return c.json({error: 'Five letters or digits'}, 400);
    const [g] = await db.select().from(guard).where(eq(guard.userId, user));
    if (!proven(g, c.get('sessionId'))) return c.json({error: 'Confirm with a passkey.'}, 403);
    const set = {offDigest: await digestOf(user, b.code), offSetAt: new Date()};
    await db.insert(guard).values({userId: user, ...set}).onConflictDoUpdate({target: guard.userId, set});
    return c.json({set: true});
  });

  // ---- work on an issue: its own line, from main's last commit ----

  v1.get('/repos/:name/lines', async (c) => {
    const list = await db.select(lineCols).from(line).innerJoin(repo, eq(repo.id, line.repoId))
      .where(and(named(c.get('userId'), c.req.param('name')), ne(line.name, 'main'))).orderBy(line.startedAt) as Line[];
    on(list[0]?.off);
    return c.json(list.map(lineShown));
  });

  v1.post('/repos/:name/lines', async (c) => {
    const user = c.get('userId'), name = c.req.param('name');
    const b = await body<{issue?: unknown}>(c);
    const issue = typeof b?.issue === 'string' ? b.issue : '';
    const stem = /^issue\/([A-Za-z0-9][A-Za-z0-9._-]{0,60})\.md$/.exec(issue)?.[1];
    if (!stem || !validLine(stem)) return c.json({error: 'Work begins from an issue'}, 400);
    const {row, made} = await db.transaction(async (tx: Db) => {
      await lock(tx, user);
      const main = await lineAt(tx, user, name, 'main', true);
      if (!main) refuse(404, {error: 'That repo is not on the Remote'});
      on(main.off);
      const existing = await lineAt(tx, user, name, stem);
      if (existing) return {row: existing, made: false};
      const [{n}] = await tx.select({n: sql<number>`count(*)::int`}).from(line).where(and(eq(line.repoId, main.id), ne(line.name, 'main')));
      if (n >= LIMIT.lines) refuse(429, {error: 'This repo has too much work open'});
      // Work starts from what main last committed, not from main's uncommitted draft. A repo
      // nobody has committed yet gets its first commit (what it was made with) here, so the
      // work shows only what it changes.
      const head = main.head ?? (await commit(tx, user, main, {merged: null, tree: main.draft!, kind: '', title: 'Start', issue: '', note: '', added: 0, removed: 0})).id;
      // The issue itself comes along when main has it written but not committed: the work is about it.
      const from = {...(head === main.head ? (await treesOf(tx, main.id, [head]))(head) : main.draft!)};
      const written = main.draft![issue];
      if (written && !from[issue]) from[issue] = written;
      await fits(tx, user, JSON.stringify(from).length);
      await tx.insert(line).values({repoId: main.id, userId: user, name: stem, base: head, head, pushed: head, draft: from, version: 1, startedBy: c.get('name')});
      return {row: (await lineAt(tx, user, name, stem))!, made: true};
    });
    return c.json(lineShown(row), made ? 201 : 200);
  });

  // Push: the line's commits become visible as the line's state (what a change hands in).
  v1.post('/repos/:name/lines/:line/push', async (c) => {
    const user = c.get('userId'), name = c.req.param('name'), l = c.req.param('line');
    const b = await body<{head?: unknown}>(c);
    const row = await lineAt(db, user, name, l);
    if (!row) return c.json({error: 'That work is not on the Remote'}, 404);
    on(row.off);
    if (b?.head !== row.head) return c.json({head: row.head}, 409);
    const done = await db.update(line).set({pushed: row.head, updatedAt: sql`now()`})
      .where(and(lineRow(row.id, l), row.head === null ? isNull(line.head) : eq(line.head, row.head))).returning({pushed: line.pushed});
    return done.length ? c.json({pushed: row.head}) : c.json({head: (await lineAt(db, user, name, l))?.head ?? null}, 409);
  });

  // ---- changes: a line handed to main ----

  /** A change of `user`'s repo `name`, its repo's number, and whether the repo is off. */
  const changeAt = async (q: Db, user: string, name: string, id: string) => (UUID.test(id)
    ? (await q.select({...changeCols, repoId: repo.id, off: repo.offAt}).from(change).innerJoin(repo, eq(repo.id, change.repoId))
      .where(and(named(user, name), eq(change.id, id))))[0] as (Change & {repoId: number; off: Date | null}) | undefined
    : undefined);
  const changed = async (q: Db, id: string, set: Record<string, unknown>, also?: ReturnType<typeof eq>) =>
    (await q.update(change).set(set).where(and(eq(change.id, id), also)).returning(changeCols))[0] as Change | undefined;

  v1.get('/repos/:name/changes', async (c) => {
    const name = c.req.param('name');
    const r = await repoAt(db, c.get('userId'), name);
    if (!r) return c.json([]);
    on(r.off);
    const list = await db.select(changeCols).from(change).where(eq(change.repoId, r.id)).orderBy(desc(change.updatedAt)) as Change[];
    return c.json(list.map((x) => changeShown(name, x)));
  });

  // Submit change: what the line has pushed, measured against main's last commit. Again after
  // more commits and a push, the same change gets a new version (and reviews of the old one are of the old one).
  v1.post('/repos/:name/changes', async (c) => {
    const user = c.get('userId'), name = c.req.param('name');
    const b = await body<{line?: unknown; kind?: unknown; title?: unknown; note?: unknown}>(c);
    const l = typeof b?.line === 'string' && b.line !== 'main' ? b.line : '';
    const words = {kind: typeof b?.kind === 'string' ? b.kind : '', title: typeof b?.title === 'string' ? b.title.trim() : '', note: typeof b?.note === 'string' ? b.note : ''};
    const [out, status] = await db.transaction(async (tx: Db) => {
      await lock(tx, user);
      const row = l ? await lineAt(tx, user, name, l) : undefined;
      if (!row) refuse(404, {error: 'That work is not on the Remote'});
      on(row.off);
      if (!row.pushed || row.pushed !== row.head) refuse(409, {error: 'Push first: the change is what was pushed', head: row.head, pushed: row.pushed});
      if (row.pushed === row.base) refuse(409, {error: 'Nothing committed since the work began'});
      if (!words.title || words.title.length > LIMIT.words || words.note.length > LIMIT.words || words.kind.length > LIMIT.words) refuse(400, {error: 'A change needs a title of at most 2000 characters'});
      const [was] = await tx.select({id: change.id, state: change.state, head: change.head, version: change.version}).from(change)
        .where(and(eq(change.repoId, row.id), eq(change.line, l)));
      if (was?.state === 'merged') refuse(409, {error: 'This change is merged already'});
      const now = {...words, head: row.pushed, base: row.base, state: 'open', submittedBy: c.get('name'), updatedAt: new Date()};
      if (was) return [await changed(tx, was.id, {...now, version: was.head === row.pushed && was.state === 'open' ? was.version : was.version + 1}), 200] as const;
      return [(await tx.insert(change).values({repoId: row.id, userId: user, line: l, ...now}).returning(changeCols))[0], 201] as const;
    });
    return c.json(changeShown(name, out as Change), status);
  });

  // Review: of one version; a newer push makes it a review of an older version, and says so.
  v1.post('/repos/:name/changes/:id/reviews', async (c) => {
    const user = c.get('userId'), name = c.req.param('name');
    const b = await body<{version?: unknown; verdict?: unknown; note?: unknown; marks?: unknown}>(c);
    const out = await db.transaction(async (tx: Db) => {
      await lock(tx, user);
      const row = await changeAt(tx, user, name, c.req.param('id'));
      if (!row) refuse(404, {error: 'No such change'});
      on(row.off);
      if (b?.version !== row.version) refuse(409, {version: row.version});
      if (!['approve', 'changes', 'comment'].includes(String(b?.verdict))) refuse(400, {error: 'verdict'});
      if (row.reviews.length >= LIMIT.reviews) refuse(429, {error: 'Too many reviews on this change'});
      // Lines marked in the diff, as "path:index" (the index of the line in that file's diff), as many as fit.
      const marks: string[] = [];
      let chars = 0;
      for (const m of new Set(Array.isArray(b?.marks) ? b.marks : [])) {
        if (typeof m !== 'string' || m.length > 1100 || marks.length >= LIMIT.marks || chars + m.length > LIMIT.markChars) continue;
        marks.push(m);
        chars += m.length;
      }
      const note = typeof b?.note === 'string' ? b.note.slice(0, LIMIT.words) : '';
      await fits(tx, user, note.length + JSON.stringify(marks).length);
      await tx.insert(review).values({changeId: row.id, userId: user, version: row.version, verdict: b!.verdict as Review['verdict'], note, marks, by: c.get('name')});
      return (await changeAt(tx, user, name, row.id))!;
    });
    return c.json(changeShown(name, out), 201);
  });

  // Merge: main takes the change, file by file against where the change began; a file both changed is a conflict.
  v1.post('/repos/:name/changes/:id/merge', async (c) => {
    const user = c.get('userId'), name = c.req.param('name');
    const b = await body<{version?: unknown}>(c);
    const out = await db.transaction(async (tx: Db) => {
      await lock(tx, user);
      const row = await changeAt(tx, user, name, c.req.param('id'));
      if (!row) refuse(404, {error: 'No such change'});
      on(row.off);
      if (row.state !== 'open') refuse(409, {error: 'The change is not open any more', state: row.state});
      if (b?.version !== row.version) refuse(409, {version: row.version});
      const main = await lineAt(tx, user, name, 'main', true);
      if (!main) refuse(404, {error: 'That repo is not on the Remote'});
      const tree = await treesOf(tx, main.id, [row.base, main.head, row.head]);
      const merged = merge3(tree(row.base), tree(main.head), tree(row.head));
      if (merged.conflicts.length) refuse(409, {conflicts: merged.conflicts});
      // main's uncommitted draft keeps its own changes; what the merge brings is laid over it.
      const draft = merge3(tree(main.head), main.draft!, merged.tree);
      if (draft.conflicts.length) refuse(409, {conflicts: draft.conflicts, draft: true});
      const made = await commit(tx, user, main, {merged: row.head, tree: merged.tree, kind: row.kind, title: row.title,
        issue: issueOf(row.line), note: row.note, added: 0, removed: 0}, draft.tree);
      return {merged: made.id, ...changeShown(name, (await changed(tx, row.id, {state: 'merged', updatedAt: new Date()}))!)};
    });
    return c.json(out);
  });

  // Reject (the receiver does not take it) and Reset (the one who submitted it takes it back).
  for (const [verb, state] of [['reject', 'rejected'], ['reset', 'reset']] as const) {
    v1.post(`/repos/:name/changes/:id/${verb}`, async (c) => {
      const user = c.get('userId'), name = c.req.param('name');
      const row = await changeAt(db, user, name, c.req.param('id'));
      if (!row) return c.json({error: 'No such change'}, 404);
      on(row.off);
      const b = await body<{note?: unknown}>(c);
      const note = typeof b?.note === 'string' && b.note ? {note: b.note.slice(0, LIMIT.words)} : {};
      const done = row.state === 'open' && await changed(db, row.id, {state, ...note, updatedAt: new Date()}, eq(change.state, 'open'));
      return done ? c.json(changeShown(name, done)) : c.json({error: 'The change is not open any more', state: (await changeAt(db, user, name, row.id))?.state ?? row.state}, 409);
    });
  }
}
