// Repos kept: the canonical copy of each of an account's repos (DESIGN.md
// §6, "The canonical copy is on the Remote"). A repo is lines of work, main
// and one per issue; each line a draft (the working tree, path -> digest,
// versioned), a head (its last commit) and what it pushed. Rows only: the
// files a tree names are blobs (files.ts).
//
//   GET    /v1/moved                  what moved, cheaply: {repos: stamp, home: {key: version}}
//   GET    /v1/repos                  each repo: head, draft version, bytes, when
//   GET    /v1/repos/gone             each repo that went for good, lately: [{name, at}]
//   GET    /v1/repos/:name            a line's draft (tree, version, base), its files' modes and head (?line=, main by default)
//                                      -> 404 {gone} when it went for good
//   PATCH  /v1/repos/:name/draft      {version, set, remove, modes?}: a diff on that version (modes: each set path's
//                                      mode where it has an execute bit; without modes, a set path keeps its own)
//                                      -> {version} | 409 {version} | 409 {missing}
//                                      | 410 {gone} for a name that went, unless ?anew=1 makes it again
//   POST   /v1/repos/:name/cuts       {version, parent, kind, title, issue, note, added, removed, paths?}:
//                                      the draft at that version becomes a cut (with paths, only those of it);
//                                      on main, it is pushed too (what a server's people see)
//   GET    /v1/repos/:name/cuts/:id
//   GET    /v1/repos/:name/log        from the line's head along first parents, each commit with what it changed
//                                      (files, folders); ?summary=1 leaves each one's tree out
//   POST   /v1/repos/:name/off | on   off: a passkey just now, the names and the code; on: back at once
//   POST   /v1/repos/:name/discard    an off repo goes for good, now (asked as off is)
//   GET    /v1/off-code  POST {code}
//   GET    /v1/repos/:name/lines      the work on its issues; POST {issue} starts one
//   POST   /v1/repos/:name/lines/:line/push {head}
//   GET    /v1/repos/:name/changes    POST {line, kind, title, note}: Submit change
//   GET    /v1/standing?repo=a&repo=b each repo asked: {name, lines, changes} as the two routes above answer them,
//                                      or {name, status: 410, error, offAt, until} for one turned off
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
import {passkeyJustNow} from './auth.ts';
import type {Plans} from './plan.ts';
import {ago, body, fits as fitsIn, fitting, HEX, LIMIT, lock, ms, qualified, refuse, rows, sha256, usedBy, UUID, type Db, type Vars} from './request.ts';
import {blob, change, cut, guard, line, repo, repoGone, review, type Modes, type Review, type Tree} from './schema.ts';
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
export function merge3<V>(base: Record<string, V>, ours: Record<string, V>, theirs: Record<string, V>): {tree: Record<string, V>; conflicts: string[]} {
  const tree: Record<string, V> = {}, conflicts: string[] = [];
  const get = (t: Record<string, V>, p: string) => (p in t ? t[p] : undefined);
  for (const p of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
    const b = get(base, p), o = get(ours, p), t = get(theirs, p);
    const pick = o === t ? o : o === b ? t : t === b ? o : (conflicts.push(p), o);
    if (pick !== undefined) tree[p] = pick;
  }
  // Each side's tree is one a disk can hold; the two laid together may not be (a file on one, a folder on the other).
  for (const p of clashes(tree)) if (!conflicts.includes(p)) conflicts.push(p);
  return {tree, conflicts: conflicts.sort()};
}

/** A lone half of a surrogate pair: not text Postgres (or a file system) takes. */
const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/**
 * A repo path as the app allows one: no .., no empty part, never .git however spelt; no control character, no
 * backslash or colon (a Windows client reads either as a way to another place: `a\b`, `.git::$INDEX_ALLOCATION`),
 * no lone surrogate, and never `__proto__` (a tree is a plain object: that key would be taken as its prototype).
 */
export function validPath(p: string): boolean {
  if (!p || p.length > 1024 || p.startsWith('/') || p === '__proto__' || /[\u0000-\u001f\u007f\\:]/.test(p) || LONE.test(p)) return false;
  return p.split('/').every((part) => {
    if (!part || part === '.' || part === '..') return false;
    const n = part.replace(/[‌-‏‪-‮⁪-⁯﻿]/g, '').toLowerCase().replace(/[. ]+$/, '');
    return n !== '.git' && n !== 'git~1';
  });
}

/**
 * The paths of `tree` that are a file and a folder at once: `a` a file, and `a/b` named too. No client can lay such
 * a tree out on a disk; a draft is refused one, and a merge says each as a conflict. (A folder may be named beside
 * what is in it, `a: null`: that is no clash.)
 */
export function clashes(tree: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const p of Object.keys(tree)) {
    for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) if (typeof tree[p.slice(0, i)] === 'string') { out.push(p.slice(0, i)); break; }
  }
  return [...new Set(out)].sort();
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

/** A file's mode as a client may send one: permission bits only, with an execute bit (a plain file has none kept). */
export const validMode = (m: unknown): m is number => typeof m === 'number' && Number.isInteger(m) && m >= 0 && m <= 0o777 && (m & 0o111) !== 0;

/** The modes kept beside `tree`: only its files' (a folder, or a path it does not name, keeps none). */
export function modesFor(tree: Tree, modes: Modes): Modes {
  const out: Modes = {};
  for (const [p, m] of Object.entries(modes)) if (typeof tree[p] === 'string' && validMode(m)) out[p] = m;
  return out;
}

/**
 * A draft's modes with a diff laid on it. A client that keeps modes sends them (`sent`): each path it sets
 * takes its mode from them, none there being a plain file's. One that sends none (an older client) cannot
 * say, so a path it sets keeps the mode it had (an execute bit is never dropped by not being known of).
 */
export function applyModes(was: Modes, tree: Tree, set: Tree, sent: Modes | undefined): Modes {
  const out: Modes = {...was};
  if (sent) for (const p of Object.keys(set)) { if (p in sent) out[p] = sent[p]; else delete out[p]; }
  return modesFor(tree, out);
}

/** A cut's id: the digest of what it records, in one fixed order (its modes last, and only when it has some: the ids of commits without stay as they were). */
export async function cutId(c: {repo: string; parent: string | null; tree: Tree; modes?: Modes; kind: string; title: string; issue: string; note: string; time: number}) {
  const tree = Object.keys(c.tree).sort().map((p) => [p, c.tree[p]]);
  const modes = Object.keys(c.modes ?? {}).sort().map((p) => [p, c.modes![p]]);
  return sha256(enc.encode(JSON.stringify([c.repo, c.parent, tree, c.kind, c.title, c.issue, c.note, c.time, ...(modes.length ? [modes] : [])])));
}

/** A commit as clients read it. */
const cutCols = {id: cut.id, parent: cut.parent, merged: cut.merged, tree: cut.tree, modes: cut.modes, kind: cut.kind, title: cut.title, issue: cut.issue,
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
  startedBy: string; startedAt: Date; updatedAt: Date; draft?: Tree; modes?: Modes; kept?: {bytes: number; files: number};
  /** Read with its draft: the account's room (request.ts usedBy), and which of the blobs asked about it holds. */
  used?: number; have?: string[]};
type Change = {id: string; line: string; kind: string; title: string; version: number; base: string | null; head: string;
  state: string; note: string; submittedBy: string; reviews: Review[]; updatedAt: Date};

const lineShown = ({id: _, off: __, draft, modes, kept: ___, used: ____, have: _____, ...r}: Line) => ({...r, issue: issueOf(r.line), ...(draft ? {draft, modes: modesFor(draft, modes ?? {})} : {}), startedAt: r.startedAt.getTime()});
const changeShown = (repoName: string, {repoId: _, off: __, ...r}: Change & {repoId?: number; off?: Date | null}) =>
  ({...r, repo: repoName, issue: issueOf(r.line), updatedAt: r.updatedAt.getTime()});
const count = (n: unknown) => (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 2 ** 31 ? n : 0);

/** Who did it, as their name is now, as long as what keeps it takes (a provider's name may be longer). */
const whoBy = (c: Context<Vars>) => c.get('name').slice(0, 200);

export function repos(d: {db: Db; quota?: number; plans: Plans}, v1: Hono<Vars>) {
  const db = d.db;
  const fits = (q: Db, user: string, more: number) => fitsIn(q, user, more, d.quota);
  const fitsUsed = (used: number | undefined, more: number) => fitting(Number(used), more, d.quota);

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
  /**
   * A line (with its draft only when asked for, and what the draft takes: `kept`), its repo's number, and whether its
   * repo is off: one read.
   */
  // Read to be written (`draft`), with what the write then asks of the account in the same round trip: its room, and
  // which of the blobs `shas` it holds (a save is a lock, this, and the write: the room and the blobs were a trip each).
  const lineAt = async (q: Db, user: string, name: string, l: string, draft = false, shas: string[] = []): Promise<Line | undefined> =>
    (await q.select({...lineCols, ...(draft ? {draft: line.draft, modes: line.modes, kept: {bytes: line.bytes, files: line.fileBytes}, used: usedBy(user),
      have: shas.length ? sql<string[]>`(select coalesce(array_agg(${blob.sha256}), '{}') from ${blob} where ${and(eq(blob.userId, user), inArray(blob.sha256, shas))})`
        : sql<string[]>`'{}'::text[]`} : {})}).from(line).innerJoin(repo, eq(repo.id, line.repoId))
      .where(and(eq(repo.userId, user), eq(repo.name, name), eq(line.name, l))))[0];
  /** The row of line `l` of repo `id`. */
  const lineRow = (id: number, l: string) => and(eq(line.repoId, id), eq(line.name, l));
  /** A repo that is off answers nothing but being off, and until when it can come back. */
  /** What a repo turned off answers in place of anything else (410). */
  const offWords = (off: Date) => ({error: 'This repo is turned off', offAt: off.getTime(), until: off.getTime() + KEPT});
  const on = (off: Date | null | undefined) => { if (off) refuse(410, offWords(off)); };
  /** The names that went for good and are still remembered, each with when (sweep.ts purge). */
  const remembered = (user: string) => and(eq(repoGone.userId, user), sql`${repoGone.at} > ${ago(REMEMBERED)}`);
  /** When `name` went for good, if it did lately. */
  const goneAt = async (q: Db, user: string, name: string) =>
    ((await q.select({at: repoGone.at}).from(repoGone).where(and(remembered(user), eq(repoGone.name, name))))[0] as {at: Date} | undefined)?.at.getTime();
  /** The trees of the commits `ids` of repo `id`, and their modes; one not there is empty. */
  const treesOf = async (q: Db, id: number, ids: (string | null)[]) => {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    const found = wanted.length ? await q.select({id: cut.id, tree: cut.tree, modes: cut.modes}).from(cut).where(and(eq(cut.repoId, id), inArray(cut.id, wanted))) : [];
    const by = new Map<string, {tree: Tree; modes: Modes}>(found.map((r: {id: string; tree: Tree; modes: Modes}) => [r.id, r]));
    const tree = (c: string | null): Tree => (c && by.get(c)?.tree) || {};
    return Object.assign(tree, {modes: (c: string | null): Modes => (c && by.get(c)?.modes) || {}});
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
    const b = await body<{version?: unknown; set?: unknown; remove?: unknown; modes?: unknown}>(c);
    if (!b || typeof b.version !== 'number' || typeof b.set !== 'object' || b.set === null || Array.isArray(b.set) || !Array.isArray(b.remove)) return c.json({error: 'a diff'}, 400);
    const set = b.set as Record<string, unknown>, remove = b.remove as unknown[];
    // Each mode is of a file this diff sets, with an execute bit: anything else is not a mode a repo keeps.
    if (b.modes !== undefined && (typeof b.modes !== 'object' || b.modes === null || Array.isArray(b.modes))) return c.json({error: 'modes: path -> mode'}, 400);
    const sent = b.modes as Record<string, unknown> | undefined;
    for (const [p, m] of Object.entries(sent ?? {})) if (typeof set[p] !== 'string' || !validMode(m)) return c.json({error: 'A mode no file here may have', path: p}, 400);
    if (Object.keys(set).length + remove.length > LIMIT.diff) return c.json({error: 'Too many changes at once'}, 413);
    for (const [p, v] of Object.entries(set)) if (!validPath(p) || !(v === null || (typeof v === 'string' && HEX.test(v)))) return c.json({error: 'A path no repo may have', path: p}, 400);
    for (const p of remove) if (typeof p !== 'string' || !validPath(p)) return c.json({error: 'A path no repo may have', path: String(p)}, 400);
    const shas = [...new Set(Object.values(set).filter((v): v is string => typeof v === 'string'))];
    const version = await db.transaction(async (tx: Db) => {
      await lock(tx, user);
      const row = await lineAt(tx, user, name, l, true, shas);
      on(row?.off);
      if (!row) {
        const gone = await goneAt(tx, user, name);
        if (gone && !(anew && l === 'main')) refuse(410, {error: 'This repo was discarded on the Remote.', gone});
        // A line other than main is made by starting work on its issue, not by writing to it.
        if (l !== 'main') refuse(404, {error: 'That work is not on the Remote'});
        if (name === 'gone') refuse(400, {error: 'A repo cannot be called gone'});
      }
      if (shas.length) {
        const have = new Set(row ? row.have : (await tx.select({sha: blob.sha256}).from(blob).where(and(eq(blob.userId, user), inArray(blob.sha256, shas)))).map((r: {sha: string}) => r.sha));
        const missing = shas.filter((s) => !have.has(s));
        if (missing.length) refuse(409, {missing});
      }
      const current = row?.version ?? 0;
      if (current !== b.version) refuse(409, {version: current});
      const was = row?.draft ?? {};
      const tree = applyDiff(was, set as Tree, remove as string[]);
      // A file and a folder of one name, made by this diff (one there before is not this diff's to refuse).
      const clashed = new Set(clashes(was)), clash = clashes(tree).filter((p) => !clashed.has(p));
      if (clash.length) refuse(400, {error: 'A file and a folder of the same name', path: clash[0]});
      const modes = applyModes(row?.modes ?? {}, tree, set as Tree, sent as Modes | undefined);
      const size = JSON.stringify(tree).length;
      if (Object.keys(tree).length > LIMIT.files || size > LIMIT.tree) refuse(413, {error: 'Too many files for one repo'});
      if (!row) {
        const [{n}] = await tx.select({n: sql<number>`count(*)::int`}).from(repo).where(eq(repo.userId, user));
        if (n >= LIMIT.repos) refuse(429, {error: 'Too many repos'});
        await d.plans.newRepo(tx, user);
      }
      if (row) fitsUsed(row.used, size - JSON.stringify(was).length); else await fits(tx, user, size - JSON.stringify(was).length);
      // What the draft takes (its tree and its files, each blob once) before and after: the plan refuses one
      // that grew while the account keeps more than it allows, and the whole change is undone with it. Before is
      // as the line was read, under the account's lock (a read of its own after was one more round trip a save).
      const kept = {bytes: line.bytes, files: line.fileBytes};
      const before = row?.kept ?? {bytes: 0, files: 0};
      let after: {bytes: number; files: number}[];
      if (row) after = await tx.update(line).set({draft: tree, modes, version: current + 1, updatedAt: sql`now()`}).where(and(lineRow(row.id, l), eq(line.version, current))).returning(kept);
      else {
        await tx.delete(repoGone).where(and(eq(repoGone.userId, user), eq(repoGone.name, name)));
        const [made] = await tx.insert(repo).values({userId: user, name}).returning({id: repo.id}) as {id: number}[];
        after = await tx.insert(line).values({repoId: made.id, userId: user, name: 'main', draft: tree, modes, version: 1, startedBy: whoBy(c)}).returning(kept);
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
    w: {merged: string | null; tree: Tree; modes: Modes; kind: string; title: string; issue: string; note: string; added: number; removed: number}, draft?: {tree: Tree; modes: Modes}) => {
    if (row.used !== undefined) fitsUsed(row.used, JSON.stringify(w.tree).length); else await fits(tx, user, JSON.stringify(w.tree).length);
    const time = Date.now();
    const modes = modesFor(w.tree, w.modes);
    const id = await cutId({repo: `${row.name}${row.line === 'main' ? '' : `@${row.line}`}`, parent: row.head, tree: w.tree, modes, kind: w.kind, title: w.title, issue: w.issue, note: w.note, time});
    await tx.insert(cut).values({repoId: row.id, id, userId: user, parent: row.head, merged: w.merged, tree: w.tree, modes, kind: w.kind, title: w.title,
      issue: w.issue, note: w.note, added: w.added, removed: w.removed, time: new Date(time)}).onConflictDoNothing();
    // main is what the servers a repo is shown in see (seen.ts reads what it pushed): a commit on main, or a change
    // merged into it, is pushed with it, so they see main's last commit, never an older one or nothing.
    const pushed = row.line === 'main' ? {pushed: id} : {};
    const moved = await tx.update(line).set({head: id, ...pushed, updatedAt: sql`now()`, ...(draft ? {draft: draft.tree, modes: modesFor(draft.tree, draft.modes), version: row.version + 1} : {})})
      .where(and(lineRow(row.id, row.line), eq(line.version, row.version), row.head === null ? isNull(line.head) : eq(line.head, row.head))).returning({head: line.head});
    if (!moved.length) refuse(409, {head: row.head, version: row.version});
    return {id, time};
  };

  // Commit: a line's draft at `version` becomes the next commit after `parent`. With `paths`, only those paths of
  // the draft (each as the draft has it, or gone where it has it no more) go in, everything else as `parent` has it,
  // and the draft stays as it was: an issue's own file is committed by itself as it is written, never riding in the
  // commit of whatever else the draft holds.
  v1.post('/repos/:name/cuts', async (c) => {
    const user = c.get('userId'), name = c.req.param('name'), l = lineOf(c);
    const b = await body<{version?: unknown; parent?: unknown; kind?: unknown; title?: unknown; issue?: unknown; note?: unknown; added?: unknown; removed?: unknown; paths?: unknown}>(c);
    if (!b || typeof b.version !== 'number' || !(b.parent === null || (typeof b.parent === 'string' && HEX.test(b.parent)))) return c.json({error: 'a cut'}, 400);
    const words = {kind: b.kind ?? '', title: b.title, issue: b.issue ?? '', note: b.note ?? ''};
    for (const v of Object.values(words)) if (typeof v !== 'string' || v.length > LIMIT.words) return c.json({error: 'Words of at most 2000 characters'}, 400);
    if (!(words.title as string).trim()) return c.json({error: 'A commit needs a title'}, 400);
    const only = b.paths;
    if (only !== undefined && (!Array.isArray(only) || !only.length || only.length > LIMIT.diff || !only.every((p) => typeof p === 'string' && validPath(p)))) {
      return c.json({error: 'paths: the paths of the draft to commit'}, 400);
    }
    const made = await db.transaction(async (tx: Db) => {
      await lock(tx, user);
      const row = await lineAt(tx, user, name, l, true);
      on(row?.off);
      if (!row || row.version !== b.version || row.head !== b.parent) refuse(409, {head: row?.head ?? null, version: row?.version ?? 0});
      let tree = row.draft!, modes = row.modes ?? {};
      if (only) {
        const head = await treesOf(tx, row.id, [row.head]);
        tree = {...head(row.head)};
        modes = {...head.modes(row.head)};
        for (const p of only as string[]) {
          if (p in row.draft!) tree[p] = row.draft![p]; else delete tree[p];
          if (p in (row.modes ?? {})) modes[p] = row.modes![p]; else delete modes[p];
        }
        const clash = clashes(tree);
        if (clash.length) refuse(400, {error: 'A file and a folder of the same name', path: clash[0]});
      }
      return commit(tx, user, row, {merged: null, tree, modes, ...(words as {kind: string; title: string; issue: string; note: string}),
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
  // from where it began. One walk in the database, each step one lookup of the repo's commits by their
  // key. Each commit says what it changed from its parent (files, folders: 0007's cut_change); with
  // ?summary=1 that is all, and no tree is read or sent (a client that compares trees itself asks without).
  /** The most of the log's trees one answer holds, as the database keeps them (compressed). */
  const TREES_AT_ONCE = 8 << 20;
  v1.get('/repos/:name/log', async (c) => {
    const limit = Math.min(LIMIT.log, Math.max(1, Math.floor(Number(c.req.query('limit') ?? 50)) || 50));
    const summary = c.req.query('summary') === '1';
    const trees = summary ? sql`` : sql`c.tree, c.modes, `;
    const row = await lineAt(db, c.get('userId'), c.req.param('name'), lineOf(c));
    on(row?.off);
    if (!row?.head) return c.json([]);
    // With trees, no more of them than TREES_AT_ONCE as kept (each may be 8 MB; 50 were past what a Worker holds,
    // and every request on it failed with it): fewer commits, and the last one's parent says where the rest go on.
    const room = summary ? sql`` : sql`and w.held + pg_column_size(c.tree) < ${TREES_AT_ONCE}`;
    return c.json(await rows(db, sql`with recursive walk(id, n, held) as (
        select ${row.head}::text, 1, 0::bigint
        union all
        select c.parent, w.n + 1, w.held + pg_column_size(c.tree) from walk w join cut c on c.repo_id = ${row.id} and c.id = w.id
        where c.parent is not null and w.n < ${limit} ${room}
      )
      select c.id, c.parent, c.merged, ${trees}c.kind, c.title, c.issue, c.note, c.added, c.removed, ${ms(sql`c.time`)} as time,
        coalesce(c.files, 0) as files, coalesce(c.folders, '{}') as folders
      from walk w join cut c on c.repo_id = ${row.id} and c.id = w.id order by w.n`));
  });

  // ---- turning a repo off: kept 30 days, back at once until then, or discarded now ----

  /**
   * What turning a repo off asks, and discarding it: a passkey just now (this very session signed in with one), and
   * the repo's name written out, sent as {repo}, as GitHub asks for a repository's name before it is deleted: the
   * person is at the device, and means this repo. Refused (403) unless both are so. There is no code of the
   * account's to set and keep in mind as well: a passkey is the person, and the name is what they mean.
   */
  const confirmed = async (c: Context<Vars>, name: string) => {
    const b = await body<{repo?: unknown}>(c);
    const [g] = await db.select().from(guard).where(eq(guard.userId, c.get('userId'))) as (typeof guard.$inferSelect)[];
    if (!passkeyJustNow(g, c.get('sessionId'))) refuse(403, {error: 'Confirm with a passkey.'});
    if (b?.repo !== name) refuse(403, {error: 'The name does not match.'});
  };
  const named = (user: string, name: string) => and(eq(repo.userId, user), eq(repo.name, name));

  // Off: asks for a passkey just now and the repo's name.
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

  // ---- work on an issue: its own line, from main's last commit ----

  v1.get('/repos/:name/lines', async (c) => {
    // The repo and its work in one read (two before, for a repo with none, as most are): no row is no repo, and a row
    // with no line is a repo with no work open.
    const list = await db.select(lineCols).from(repo).leftJoin(line, and(eq(line.repoId, repo.id), ne(line.name, 'main')))
      .where(named(c.get('userId'), c.req.param('name'))).orderBy(line.startedAt) as (Omit<Line, 'line'> & {line: string | null})[];
    // A repo turned off says so, lines or none.
    on(list[0]?.off);
    return c.json(list.filter((x): x is Line => x.line !== null).map(lineShown));
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
      const head = main.head ?? (await commit(tx, user, main, {merged: null, tree: main.draft!, modes: main.modes ?? {}, kind: '', title: 'Start', issue: '', note: '', added: 0, removed: 0})).id;
      // The issue itself comes along when main has it written but not committed: the work is about it.
      const cuts = await treesOf(tx, main.id, [head]);
      const from = {...(head === main.head ? cuts(head) : main.draft!)};
      const fromModes = head === main.head ? cuts.modes(head) : main.modes ?? {};
      const written = main.draft![issue];
      if (written && !from[issue]) from[issue] = written;
      await fits(tx, user, JSON.stringify(from).length);
      await tx.insert(line).values({repoId: main.id, userId: user, name: stem, base: head, head, pushed: head, draft: from, modes: modesFor(from, fromModes), version: 1, startedBy: whoBy(c)});
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
    // The newest 200: a repo's changes are kept, and each says its reviews. Read with the repo, in one read (two
    // before; the app asks it each time Forge or Git is shown): no row is no repo, a row with no change a repo with none.
    const list = await db.select({...changeCols, off: repo.offAt}).from(repo).leftJoin(change, eq(change.repoId, repo.id))
      .where(named(c.get('userId'), name)).orderBy(desc(change.updatedAt)).limit(200) as ((Omit<Change, 'id'> & {id: string | null; off: Date | null}))[];
    if (!list.length) return c.json([]);
    on(list[0].off);
    return c.json(list.filter((x): x is Change & {off: Date | null} => x.id !== null).map((x) => changeShown(name, x)));
  });

  // Where each repo asked stands, for Git's page: its lines and changes as the two routes above answer them (the newest
  // 200 changes of each), every repo's in two reads. Git asked those two of each repo, one after the other, each a round
  // trip of its own. A repo turned off is said as they say it; one not on the Remote has neither, as they answer.
  v1.get('/standing', async (c) => {
    const user = c.get('userId');
    const names = [...new Set(c.req.queries('repo') ?? [])].slice(0, LIMIT.repos);
    if (!names.length) return c.json([]);
    const asked = and(eq(repo.userId, user), inArray(repo.name, names));
    const lines = await db.select(lineCols).from(repo).leftJoin(line, and(eq(line.repoId, repo.id), ne(line.name, 'main')))
      .where(asked).orderBy(line.startedAt) as (Omit<Line, 'line'> & {line: string | null})[];
    const newest = db.select({...changeCols, repo: sql<string>`${repo.name}`.as('repo'),
      n: sql<number>`row_number() over (partition by ${change.repoId} order by ${change.updatedAt} desc)`.as('n')})
      .from(repo).innerJoin(change, eq(change.repoId, repo.id)).where(asked).as('newest');
    const changes = await db.select().from(newest).where(sql`${newest.n} <= 200`).orderBy(desc(newest.updatedAt)) as (Change & {repo: string; n: number})[];
    return c.json(names.map((name) => {
      const its = lines.filter((x) => x.name === name);
      if (its[0]?.off) return {name, status: 410, ...offWords(its[0].off)};
      return {name, lines: its.filter((x): x is Line => x.line !== null).map(lineShown),
        changes: changes.filter((x) => x.repo === name).map(({repo: _, n: __, ...x}) => changeShown(name, x))};
    }));
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
      const now = {...words, head: row.pushed, base: row.base, state: 'open', submittedBy: whoBy(c), updatedAt: new Date()};
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
      await tx.insert(review).values({changeId: row.id, userId: user, version: row.version, verdict: b!.verdict as Review['verdict'], note, marks, by: whoBy(c)});
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
      // What main holds after is held to what any of its saves is (a repo of more files than it may hold would refuse every save after).
      for (const t of [merged.tree, draft.tree]) if (Object.keys(t).length > LIMIT.files || JSON.stringify(t).length > LIMIT.tree) refuse(413, {error: 'Too many files for one repo'});
      // Modes are merged as the trees are; one both changed keeps main's (a mode is never what refuses a merge).
      const modes = modesFor(merged.tree, merge3(tree.modes(row.base), tree.modes(main.head), tree.modes(row.head)).tree);
      const draftModes = modesFor(draft.tree, merge3(tree.modes(main.head), main.modes ?? {}, modes).tree);
      const made = await commit(tx, user, main, {merged: row.head, tree: merged.tree, modes, kind: row.kind, title: row.title,
        issue: issueOf(row.line), note: row.note, added: 0, removed: 0}, {tree: draft.tree, modes: draftModes});
      // Still open: a reject or reset that came between is not overwritten (and the merge is undone with this refusal).
      const done = await changed(tx, row.id, {state: 'merged', updatedAt: new Date()}, eq(change.state, 'open'));
      if (!done) refuse(409, {error: 'The change is not open any more'});
      return {merged: made.id, ...changeShown(name, done)};
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
