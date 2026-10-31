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
import {above as foldersAbove, build, changes, edit, flatBytes, nodeId, type Node} from './trees.ts';

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

/** The folders above each of `paths` (`a/b/c`: `a`, `a/b`), each once. */
const above = (paths: string[]) => [...new Set(paths.flatMap((p) => p.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/'))))];

/** Whether a path goes with `remove`: it, or a folder it is in, is taken away (its own ancestors are looked up, not every path removed). */
function removedBy(remove: string[]): (p: string) => boolean {
  const gone = new Set(remove);
  return (p) => {
    if (!gone.size) return false;
    for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) if (gone.has(p.slice(0, i))) return true;
    return gone.has(p);
  };
}

/** A draft with a diff laid on it: `remove` takes a path and everything under it, then `set` is written. */
export function applyDiff(draft: Tree, set: Tree, remove: string[]): Tree {
  const removed = removedBy(remove);
  const tree: Tree = {};
  for (const [p, v] of Object.entries(draft)) if (!removed(p)) tree[p] = v;
  return Object.assign(tree, set);
}

/** A file's mode as a client may send one: permission bits only, with an execute bit (a plain file has none kept). */
const validMode = (m: unknown): m is number => typeof m === 'number' && Number.isInteger(m) && m >= 0 && m <= 0o777 && (m & 0o111) !== 0;

/** The modes kept beside `tree`: only its files' (a folder, or a path it does not name, keeps none). */
function modesFor(tree: Tree, modes: Modes): Modes {
  const out: Modes = {};
  for (const [p, m] of Object.entries(modes)) if (typeof tree[p] === 'string' && validMode(m)) out[p] = m;
  return out;
}

/**
 * A draft's modes with a diff laid on it, the draft never read: what was kept is of its files, so a path the diff does
 * not touch keeps its mode, one it takes away loses it, and one it sets is a file only when set to a blob. A client that
 * keeps modes sends them (`sent`): each file it sets takes its mode from them, none there being a plain file's. One that
 * sends none (an older client) cannot say, so a file it sets keeps the mode it had (an execute bit is never dropped by
 * not being known of).
 */
function modesAfter(was: Modes, set: Tree, remove: string[], sent: Modes | undefined): Modes {
  const removed = removedBy(remove);
  const out: Modes = {};
  for (const [p, m] of Object.entries(was)) if (!(p in set) && !removed(p)) out[p] = m;
  for (const [p, v] of Object.entries(set)) {
    if (typeof v !== 'string') continue;
    if (sent) { if (p in sent) out[p] = sent[p]; } else if (p in was) out[p] = was[p];
  }
  return out;
}

/**
 * A cut's id: the digest of what it records, in one fixed order (its modes last, and only when it has some: the ids of
 * commits without stay as they were). Its tree is its root's name (trees.ts), or, for a commit made before roots, the
 * tree whole.
 */
export async function cutId(c: {repo: string; parent: string | null; tree?: Tree; root?: string; modes?: Modes; kind: string; title: string; issue: string; note: string; time: number}) {
  const tree = c.root ?? Object.keys(c.tree ?? {}).sort().map((p) => [p, c.tree![p]]);
  const modes = Object.keys(c.modes ?? {}).sort().map((p) => [p, c.modes![p]]);
  return sha256(enc.encode(JSON.stringify([c.repo, c.parent, tree, c.kind, c.title, c.issue, c.note, c.time, ...(modes.length ? [modes] : [])])));
}

/** How many of a line's last saves are kept as what each changed (line_change), for devices a few saves behind. */
const LINE_CHANGES = 64;
/**
 * What a path and its value take of a draft's JSON as Postgres writes it out (`"path": "sha", `): a line's bytes are the
 * sum of its rows' (0022 counted the drafts kept before so), and a save adds and takes away its rows'.
 */
const entryBytes = (p: ReturnType<typeof sql>, v: ReturnType<typeof sql>) => sql`(octet_length(to_json(${p})::text) + coalesce(octet_length(to_json(${v})::text), 4) + 4)`;
/** A line's draft as one value (0022: a row a path), each folder named beside what is in it a null. */
const draftOf = (id: unknown, l: unknown) => sql<Tree>`(select coalesce(jsonb_object_agg(f.path, f.sha), '{}'::jsonb) from line_file f where f.repo_id = ${id} and f.line = ${l})`;
/** A commit as clients read it: its tree whole, however it is kept (0020 cut_tree). */
const cutTree = sql<Tree>`cut_tree(${cut.repoId}, ${cut.id})`;
const cutCols = {id: cut.id, parent: cut.parent, merged: cut.merged, tree: cutTree, modes: cut.modes, kind: cut.kind, title: cut.title, issue: cut.issue,
  note: cut.note, added: cut.added, removed: cut.removed, time: cut.time};
/** A line as clients read it: `name` is its repo's, `line` its own; `id` (its repo's number) and `off` are the service's. */
const lineCols = {id: repo.id, off: repo.offAt, name: repo.name, line: line.name, base: line.base, head: line.head, pushed: line.pushed,
  version: line.version, startedBy: line.startedBy, startedAt: line.startedAt, updatedAt: line.updatedAt};
/** A change as clients read it, its reviews newest first. */
const changeCols = {id: change.id, line: change.line, kind: change.kind, title: change.title, version: change.version, base: change.base,
  head: change.head, state: change.state, note: change.note, submittedBy: change.submittedBy, updatedAt: change.updatedAt,
  reviews: sql<Review[]>`coalesce((select jsonb_agg(jsonb_build_object('version', r.version, 'verdict', r.verdict, 'note', r.note, 'marks', r.marks,
    'by', r.by, 'time', ${ms(sql`r.time`)}) order by r.time desc, r.id) from review r where r.change_id = ${qualified(change.id)}), '[]'::jsonb)`.as('reviews')};
/** What a draft would be with a save laid on it, as its rows say (lineAt): a file and a folder of one name it makes, and what it would take. */
type After = {clash: string | null; paths: number; bytes: number; files: number};
type Line = {id: number; off: Date | null; name: string; line: string; base: string | null; head: string | null; pushed: string | null; version: number;
  startedBy: string; startedAt: Date; updatedAt: Date; draft?: Tree | null; modes?: Modes; kept?: {bytes: number; files: number}; after?: After;
  /** Read to be committed: its head's root, modes and size, the paths its saves touched, and the commit they are of. */
  headRoot?: string | null; headModes?: Modes | null; headSize?: number | null; touched?: string[]; touchedFrom?: string | null;
  /** Read to be written: the account's room (request.ts usedBy), and which of the blobs asked about it holds. */
  used?: number; have?: string[]};
type Change = {id: string; line: string; kind: string; title: string; version: number; base: string | null; head: string;
  state: string; note: string; submittedBy: string; reviews: Review[]; updatedAt: Date};

const lineShown = ({id: _, off: __, draft: ___, modes: ____, kept: _____, after: ______, used: _______, have: ________, headRoot: _9, headModes: _10, headSize: _11,
  touched: _12, touchedFrom: _13, ...r}: Line) => ({...r, issue: issueOf(r.line), startedAt: r.startedAt.getTime()});
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
  // A save (`diff`: {set, remove} as JSON) is asked about here, of the rows it touches and no others: what it would make
  // a file and a folder at once that was not one before (a path it sets with a file above it, or a file it sets with
  // something under it), and how many paths, bytes and files' bytes the draft would take after it (`after`).
  const lineAt = async (q: Db, user: string, name: string, l: string, o: {draft?: boolean; shas?: string[]; diff?: string; commit?: boolean | 'draft'} = {}): Promise<Line | undefined> => {
    const shas = o.shas ?? [];
    const here = sql`d.repo_id = ${line.repoId} and d.line = ${line.name}`;
    // Each asked of the draft's rows a path at a time, by its key (one row at it, or the range under it): asked as a
    // scalar (never EXISTS, which Postgres may answer by reading all the line's rows once into a table, and at 20,000
    // rows that was most of a save's time).
    /** Rows of the draft at `p`, and under it (a range of the key, paths being compared byte by byte). */
    const at = (p: ReturnType<typeof sql>) => sql`${here} and d.path = ${p}`;
    const under = (p: ReturnType<typeof sql>) => sql`${here} and d.path >= ${p} || '/' and d.path < ${p} || '0'`;
    const fileBefore = (p: ReturnType<typeof sql>) => sql`coalesce((select d.sha is not null from line_file d where ${at(p)}), false)`;
    const anyUnder = (p: ReturnType<typeof sql>, also = sql`true`) => sql`(select true from line_file d where ${under(p)} and ${also} limit 1) is not null`;
    const clashBefore = (p: ReturnType<typeof sql>) => sql`(${fileBefore(p)} and ${anyUnder(p)})`;
    const kept = (p: ReturnType<typeof sql>) => sql`not exists (select 1 from g where g.path = ${p})`;
    const after = o.diff ? sql<After>`(with s(k, v) as materialized (select e.key, e.value #>> '{}' from jsonb_each((${o.diff}::jsonb) -> 'set') e),
        r(k) as materialized (select distinct x from jsonb_array_elements_text((${o.diff}::jsonb) -> 'remove') x),
        g as materialized (select distinct d.path, d.sha from r cross join lateral (select d.path, d.sha from line_file d where ${at(sql`r.k`)}
            union all select d.path, d.sha from line_file d where ${under(sql`r.k`)}) d where not exists (select 1 from s where s.k = d.path)),
        o as materialized (select d.path, d.sha from s cross join lateral (select d.path, d.sha from line_file d where ${at(sql`s.k`)} limit 1) d),
        a(k) as materialized (select x from jsonb_array_elements_text((${o.diff}::jsonb) -> 'above') x),
        clash(p) as (select s.k from s where s.v is not null and not ${clashBefore(sql`s.k`)}
            and (exists (select 1 from s t where starts_with(t.k, s.k || '/')) or ${anyUnder(sql`s.k`, kept(sql`d.path`))})
          union select a.k from a where not ${clashBefore(sql`a.k`)} and case when exists (select 1 from s where s.k = a.k)
            then exists (select 1 from s where s.k = a.k and s.v is not null) else ${fileBefore(sql`a.k`)} and ${kept(sql`a.k`)} end),
        x(sha) as materialized (select v from s where v is not null union select sha from o where sha is not null union select sha from g where sha is not null),
        y as (select (select true from line_file d where ${here} and d.sha = x.sha limit 1) is not null as before,
            exists (select 1 from s where s.v = x.sha) or (select count(*) from line_file d where ${here} and d.sha = x.sha)
              > (select count(*) from o where o.sha = x.sha) + (select count(*) from g where g.sha = x.sha) as after,
            coalesce((select b.bytes from blob b where b.user_id = ${user} and b.sha256 = x.sha), 0) as bytes from x),
        n as (select ${line.paths} + (select count(*) from s where not exists (select 1 from o where o.path = s.k)) - (select count(*) from g) as paths,
            coalesce((select sum(${entryBytes(sql`s.k`, sql`s.v`)}) from s), 0) - coalesce((select sum(${entryBytes(sql`o.path`, sql`o.sha`)}) from o), 0)
              - coalesce((select sum(${entryBytes(sql`g.path`, sql`g.sha`)}) from g), 0) as bytes,
            coalesce((select sum(case when y.after and not y.before then y.bytes when y.before and not y.after then -y.bytes else 0 end) from y), 0) as files)
      select jsonb_build_object('clash', (select min(clash.p collate "C") from clash), 'paths', n.paths,
        'bytes', case when n.paths = 0 then 2 else case when ${line.paths} = 0 then 0 else ${line.bytes} end + n.bytes end, 'files', ${line.fileBytes} + n.files) from n)` : null;
    const written = o.draft || o.diff || o.commit;
    const head = sql`from cut k where k.repo_id = ${line.repoId} and k.id = ${line.head}`;
    return (await q.select({...lineCols, ...(o.draft ? {draft: draftOf(line.repoId, line.name)} : {}), ...(after ? {after} : {}),
      ...(o.commit ? {headRoot: sql<string | null>`(select k.root ${head})`, headModes: sql<Modes | null>`(select k.modes ${head})`,
        headSize: sql<number | null>`(select k.size ${head})`, touchedFrom: line.touchedFrom,
        // The draft whole, in this same read, only where a commit of it is to be made whole (madeOf).
        ...(o.commit === 'draft' ? {draft: sql<Tree | null>`case when ${line.head} is not null and ${line.touchedFrom} = ${line.head} and (select k.root ${head}) is not null
          then null else ${draftOf(line.repoId, line.name)} end`} : {}),
        touched: sql<string[]>`(select coalesce(array_agg(t.path), '{}') from line_touched t where t.repo_id = ${line.repoId} and t.line = ${line.name})`} : {}),
      ...(written ? {modes: line.modes, kept: {bytes: line.bytes, files: line.fileBytes}, used: usedBy(user),
        have: shas.length ? sql<string[]>`(select coalesce(array_agg(${blob.sha256}), '{}') from ${blob} where ${and(eq(blob.userId, user), inArray(blob.sha256, shas))})`
          : sql<string[]>`'{}'::text[]`} : {})}).from(line).innerJoin(repo, eq(repo.id, line.repoId))
      .where(and(eq(repo.userId, user), eq(repo.name, name), eq(line.name, l))))[0];
  };
  /** The row of line `l` of repo `id`. */
  const lineRow = (id: number, l: string) => and(eq(line.repoId, id), eq(line.name, l));
  /**
   * Line `l` of repo `id`, at `version`, with a save laid on its rows: what it takes away goes (each path, and all under
   * it, but what it sets again), what it sets is written, and nothing else is touched. What it changed is kept beside it
   * for the devices that hold the draft before it (line_change), the oldest past LINE_CHANGES let go, and the paths it
   * touched for the next commit (line_touched); and what the draft takes after it, as lineAt said. One statement;
   * nothing when the line was not at `version`.
   */
  const saved = (tx: Db, id: number, l: string, version: number, set: Tree, remove: string[], modes: Modes, after: After) =>
    rows<{ok: number}>(tx, sql`with u as (
        update line set modes = ${JSON.stringify(modes)}::jsonb, version = ${version + 1}, paths = ${after.paths}, bytes = ${after.bytes},
          file_bytes = ${after.files}, updated_at = now()
        where repo_id = ${id} and name = ${l} and version = ${version} returning 1),
      s(k, v) as materialized (select e.key, e.value #>> '{}' from jsonb_each(${JSON.stringify(set)}::jsonb) e),
      g as (delete from line_file f where f.repo_id = ${id} and f.line = ${l} and exists (select 1 from u) and not exists (select 1 from s where s.k = f.path)
        and f.path in (select d.path from jsonb_array_elements_text(${JSON.stringify(remove)}::jsonb) r(k) cross join lateral (
          select d.path from line_file d where d.repo_id = ${id} and d.line = ${l} and d.path = r.k
          union all select d.path from line_file d where d.repo_id = ${id} and d.line = ${l} and d.path >= r.k || '/' and d.path < r.k || '0') d)),
      i as (insert into line_file (repo_id, line, path, sha) select ${id}, ${l}, s.k, s.v from s where exists (select 1 from u)
        on conflict (repo_id, line, path) do update set sha = excluded.sha where line_file.sha is distinct from excluded.sha),
      c as (insert into line_change (repo_id, line, version, "set", gone) select ${id}, ${l}, ${version + 1}, ${JSON.stringify(set)}::jsonb, ${JSON.stringify(remove)}::jsonb from u),
      t as (insert into line_touched (repo_id, line, path) select ${id}, ${l}, x.k from (select s.k from s union select jsonb_array_elements_text(${JSON.stringify(remove)}::jsonb)) x
        where exists (select 1 from u) on conflict do nothing),
      d as (delete from line_change where repo_id = ${id} and line = ${l} and version <= ${version + 1 - LINE_CHANGES} and exists (select 1 from u))
      select 1 as ok from u`);
  /**
   * Line `l` of repo `id` laid down whole as `tree` (a line made, a merge's draft): the rows it no longer names go, the
   * others are written as it has them, and what it takes is counted from it. What it takes after.
   */
  const laid = async (tx: Db, id: number, l: string, tree: Tree) => (await rows<{bytes: number; files: number}>(tx, sql`with t(k, v) as materialized (
        select e.key, e.value #>> '{}' from jsonb_each(${JSON.stringify(tree)}::jsonb) e),
      g as (delete from line_file f where f.repo_id = ${id} and f.line = ${l} and not exists (select 1 from t where t.k = f.path)),
      i as (insert into line_file (repo_id, line, path, sha) select ${id}, ${l}, t.k, t.v from t
        on conflict (repo_id, line, path) do update set sha = excluded.sha where line_file.sha is distinct from excluded.sha)
    update line set paths = (select count(*) from t), bytes = coalesce((select sum(${entryBytes(sql`t.k`, sql`t.v`)}) from t), 2),
      file_bytes = (select coalesce(sum(b.bytes), 0) from blob b where b.user_id = line.user_id and b.sha256 in (select t.v from t))
    where repo_id = ${id} and name = ${l} returning bytes, file_bytes as files`))[0];
  /** A repo that is off answers nothing but being off, and until when it can come back. */
  /** What a repo turned off answers in place of anything else (410). */
  const offWords = (off: Date) => ({error: 'This repo is disabled', offAt: off.getTime(), until: off.getTime() + KEPT});
  const on = (off: Date | null | undefined) => { if (off) refuse(410, offWords(off)); };
  /** The names that went for good and are still remembered, each with when (sweep.ts purge). */
  const remembered = (user: string) => and(eq(repoGone.userId, user), sql`${repoGone.at} > ${ago(REMEMBERED)}`);
  /** When `name` went for good, if it did lately. */
  const goneAt = async (q: Db, user: string, name: string) =>
    ((await q.select({at: repoGone.at}).from(repoGone).where(and(remembered(user), eq(repoGone.name, name))))[0] as {at: Date} | undefined)?.at.getTime();
  /** The trees of the commits `ids` of repo `id`, and their modes; one not there is empty. */
  const treesOf = async (q: Db, id: number, ids: (string | null)[]) => {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    const found = wanted.length ? await q.select({id: cut.id, tree: cutTree, modes: cut.modes}).from(cut).where(and(eq(cut.repoId, id), inArray(cut.id, wanted))) : [];
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

  // The draft as the database writes it out (its rows as one JSON object), put into the answer as it comes: never read
  // into objects and written out again here (for a repo of thousands of files that was most of a request's time), its
  // modes those of its files.
  // Asked ?since=V by a device that holds the draft at version V: what each save after it changed (changes: [{set,
  // remove}], in order), when every one is kept; else, and when not asked so, the draft whole.
  v1.get('/repos/:name', async (c) => {
    const user = c.get('userId'), name = c.req.param('name');
    const since = Number(c.req.query('since')), from = Number.isInteger(since) && since > 0 ? since : null;
    const after = sql`from line_change k where k.repo_id = ${line.repoId} and k.line = ${line.name} and k.version > ${from} and k.version <= ${line.version}`;
    const kept = sql`(select count(*) ${after}) = ${line.version} - ${from}`;
    const [row] = await db.select({...lineCols,
      text: sql<string | null>`case when ${from ? kept : sql`false`} then null else (select coalesce(json_object_agg(f.path, f.sha)::text, '{}') from line_file f
        where f.repo_id = ${line.repoId} and f.line = ${line.name}) end`,
      changes: from ? sql<unknown[] | null>`case when ${kept} then (select coalesce(jsonb_agg(jsonb_build_object('set', k.set, 'remove', k.gone) order by k.version), '[]'::jsonb) ${after}) end` : sql<null>`null`,
      modes: sql<Modes>`(select coalesce(jsonb_object_agg(m.key, m.value), '{}'::jsonb) from jsonb_each(${line.modes}) m
        where exists (select 1 from line_file f where f.repo_id = ${line.repoId} and f.line = ${line.name} and f.path = m.key and f.sha is not null))`})
      .from(line).innerJoin(repo, eq(repo.id, line.repoId)).where(and(eq(repo.userId, user), eq(repo.name, name), eq(line.name, lineOf(c)))) as (Line & {text: string | null; changes: unknown[] | null})[];
    if (!row) {
      const gone = await goneAt(db, user, name);
      return c.json({error: 'Repo not found on Remote', ...(gone ? {gone} : {})}, 404);
    }
    on(row.off);
    const {text, changes, modes, ...rest} = row;
    if (text === null) return c.json({...lineShown(rest), modes, changes});
    const shown = JSON.stringify({...lineShown(rest), modes});
    return c.body(`${shown.slice(0, -1)},"draft":${text}}`, 200, {'Content-Type': 'application/json'});
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
    if (b.modes !== undefined && (typeof b.modes !== 'object' || b.modes === null || Array.isArray(b.modes))) return c.json({error: 'Format: path -> mode'}, 400);
    const sent = b.modes as Record<string, unknown> | undefined;
    for (const [p, m] of Object.entries(sent ?? {})) if (typeof set[p] !== 'string' || !validMode(m)) return c.json({error: 'Unsupported file mode', path: p}, 400);
    if (Object.keys(set).length + remove.length > LIMIT.diff) return c.json({error: 'Too many simultaneous changes'}, 413);
    for (const [p, v] of Object.entries(set)) if (!validPath(p) || !(v === null || (typeof v === 'string' && HEX.test(v)))) return c.json({error: 'Invalid repository path', path: p}, 400);
    for (const p of remove) if (typeof p !== 'string' || !validPath(p)) return c.json({error: 'Invalid repository path', path: String(p)}, 400);
    const shas = [...new Set(Object.values(set).filter((v): v is string => typeof v === 'string'))];
    const version = await db.transaction(async (tx: Db) => {
      await lock(tx, user);
      const row = await lineAt(tx, user, name, l, {shas, diff: JSON.stringify({set, remove, above: above(Object.keys(set))})});
      on(row?.off);
      if (!row) {
        const gone = await goneAt(tx, user, name);
        if (gone && !(anew && l === 'main')) refuse(410, {error: 'This repo was permanently deleted on Remote.', gone});
        // A line other than main is made by starting work on its issue, not by writing to it.
        if (l !== 'main') refuse(404, {error: 'Work not found on Remote'});
        if (name === 'gone') refuse(400, {error: 'Repo name cannot be "gone"'});
      }
      if (shas.length) {
        const have = new Set(row ? row.have : (await tx.select({sha: blob.sha256}).from(blob).where(and(eq(blob.userId, user), inArray(blob.sha256, shas)))).map((r: {sha: string}) => r.sha));
        const missing = shas.filter((s) => !have.has(s));
        if (missing.length) refuse(409, {missing});
      }
      const current = row?.version ?? 0;
      if (current !== b.version) refuse(409, {version: current});
      if (row) {
        // Laid on the rows it touches, the draft never read whole: a file and a folder of one name it makes is refused
        // (one there before is not this diff's to refuse), as is more than a repo may hold.
        const after = row.after!, before = row.kept!;
        if (after.clash !== null) refuse(400, {error: 'Filename collision with existing folder', path: after.clash});
        if (after.paths > LIMIT.files || after.bytes > LIMIT.tree) refuse(413, {error: 'File limit reached for this repo'});
        // What the draft takes (its tree and its files, each blob once) before and after: the plan refuses one that grew
        // while the account keeps more than it allows, and the whole change is undone with it.
        fitsUsed(row.used, after.bytes - before.bytes);
        const done = await saved(tx, row.id, l, current, set as Tree, remove as string[], modesAfter(row.modes ?? {}, set as Tree, remove as string[], sent as Modes | undefined), after);
        if (done.length) await d.plans.grew(tx, user, after.bytes + after.files - Number(before.bytes) - Number(before.files));
        return current + 1;
      }
      // A repo made: its draft is what the diff sets.
      const tree = applyDiff({}, set as Tree, remove as string[]);
      const clash = clashes(tree);
      if (clash.length) refuse(400, {error: 'Filename collision with existing folder', path: clash[0]});
      const size = JSON.stringify(tree).length;
      if (Object.keys(tree).length > LIMIT.files || size > LIMIT.tree) refuse(413, {error: 'File limit reached for this repo'});
      const [{n}] = await tx.select({n: sql<number>`count(*)::int`}).from(repo).where(eq(repo.userId, user));
      if (n >= LIMIT.repos) refuse(429, {error: 'Repository limit reached'});
      await d.plans.newRepo(tx, user);
      await fits(tx, user, size);
      await tx.delete(repoGone).where(and(eq(repoGone.userId, user), eq(repoGone.name, name)));
      const [made] = await tx.insert(repo).values({userId: user, name}).returning({id: repo.id}) as {id: number}[];
      await tx.insert(line).values({repoId: made.id, userId: user, name: 'main', modes: modesAfter({}, tree, [], sent as Modes | undefined), version: 1, startedBy: whoBy(c)});
      const after = await laid(tx, made.id, 'main', tree);
      await d.plans.grew(tx, user, Number(after.bytes) + Number(after.files));
      return 1;
    });
    return c.json({version});
  });

  /**
   * The parent's nodes along `folders` (each folder's node by its path, '' the root) and every node under each of
   * `subs`; and the draft's rows at each of `exact`, and at and under each of `subs`: one read.
   */
  const along = async (q: Db, id: number, l: string, root: string | null, o: {folders: string[]; subs: string[]; exact: string[]}) => {
    const subs = JSON.stringify(o.subs);
    const found = await rows<{k: 'n' | 'r'; path: string; entries: Node | null; sha: string | null}>(q, sql`with recursive
        want(p) as materialized (select jsonb_array_elements_text(${JSON.stringify([...o.folders, ...o.subs])}::jsonb)),
        sub(p) as materialized (select jsonb_array_elements_text(${subs}::jsonb)),
        w(path, id) as (select ''::text, ${root}::text where ${root}::text is not null
          union all
          select x.p, x.t from w join tree_node n on n.repo_id = ${id} and n.id = w.id
            cross join lateral (select case when w.path = '' then e.key else w.path || '/' || e.key end as p, e.value ->> 't' as t from jsonb_each(n.entries) e where e.value ? 't') x
            where exists (select 1 from want where want.p = x.p) or exists (select 1 from sub where starts_with(x.p, sub.p || '/')))
      select 'n' as k, w.path, n.entries, null::text as sha from w join tree_node n on n.repo_id = ${id} and n.id = w.id
      union all
      select 'r', d.path, null, d.sha from line_file d where d.repo_id = ${id} and d.line = ${l} and d.path in (select jsonb_array_elements_text(${JSON.stringify(o.exact)}::jsonb))
      union all
      select 'r', d.path, null, d.sha from sub cross join lateral (select d.path, d.sha from line_file d where d.repo_id = ${id} and d.line = ${l} and d.path = sub.p
        union all select d.path, d.sha from line_file d where d.repo_id = ${id} and d.line = ${l} and d.path >= sub.p || '/' and d.path < sub.p || '0') d`);
    const nodes = new Map<string, Node>(), now: Tree = {};
    for (const f of found) if (f.k === 'n') nodes.set(f.path, f.entries!); else now[f.path] = f.sha;
    return {nodes, now};
  };
  /** A tree whole, as nodes: every one, and its root's name (an empty tree's too). */
  const wholly = async (t: Tree) => {
    const b = await build(t);
    if (b.id) return {root: b.id, made: b.made};
    const empty: Node = {};
    return {root: await nodeId(empty), made: b.made.set(await nodeId(empty), empty)};
  };

  /**
   * What a commit on a line read at `row` is made of: the draft whole (`draft`), only `paths` of it (each as the draft
   * has it, or gone where it has it no more, the rest as the head has it), or a tree worked out here from the head's
   * (`tree`, a merge's, with the head's tree whole it was worked out from). Made where it changed, the head's nodes
   * read only along the paths edited: those the line's saves touched since its head (the draft whole), `paths`, or
   * those that differ (a merge). A head without a root (made before them), or touched paths not of the head, and the
   * tree is made whole, once.
   */
  type Of = {draft: true} | {paths: string[]} | {tree: Tree; from: Tree};
  const madeOf = async (tx: Db, row: Line, of: Of) => {
    const shared = !!row.head && !!row.headRoot;
    if ('draft' in of && shared && row.touchedFrom === row.head) {
      const subs = row.touched ?? [];
      const at = await along(tx, row.id, row.line, row.headRoot!, {folders: subs.flatMap((p) => foldersAbove(p).slice(1)), subs, exact: []});
      const e = await edit(at.nodes, subs.map((p) => ({path: p, subtree: true})), at.now);
      return {root: e.root, made: e.made, ...changes(e.was, e.now), size: Number(row.kept!.bytes)};
    }
    if ('paths' in of && shared) {
      const at = await along(tx, row.id, row.line, row.headRoot!, {folders: of.paths.flatMap((p) => foldersAbove(p).slice(1)), subs: [], exact: of.paths});
      const e = await edit(at.nodes, of.paths.map((p) => ({path: p, subtree: false})), at.now);
      if (e.clashes.length) refuse(400, {error: 'Filename collision with existing folder', path: e.clashes[0]});
      const size = row.headSize === null || row.headSize === undefined ? null : row.headSize + flatBytes(e.now) - flatBytes(e.was);
      return {root: e.root, made: e.made, ...changes(e.was, e.now), size};
    }
    if ('tree' in of && shared) {
      const differ = [...new Set([...Object.keys(of.from), ...Object.keys(of.tree)])].filter((p) => of.from[p] !== of.tree[p]);
      const at = await along(tx, row.id, row.line, row.headRoot!, {folders: differ.flatMap((p) => foldersAbove(p).slice(1)), subs: [], exact: []});
      const e = await edit(at.nodes, differ.map((p) => ({path: p, subtree: false})), Object.fromEntries(differ.filter((p) => p in of.tree).map((p) => [p, of.tree[p]])));
      return {root: e.root, made: e.made, ...changes(of.from, of.tree, differ), size: flatBytes(of.tree)};
    }
    // Made whole: from the draft, or the head's tree with the paths laid on it (the head's whole too, for what changed).
    const [h] = row.head ? await rows<{tree: Tree}>(tx, sql`select cut_tree(${row.id}, ${row.head}) as tree`) : [{tree: {} as Tree}];
    const was = h?.tree ?? {};
    let tree: Tree;
    if ('tree' in of) tree = of.tree;
    else if ('draft' in of) tree = row.draft ?? (await rows<{tree: Tree}>(tx, sql`select ${draftOf(row.id, row.line)} as tree`))[0].tree;
    else {
      const now = (await along(tx, row.id, row.line, null, {folders: [], subs: [], exact: of.paths})).now;
      tree = {...was};
      for (const p of of.paths) { if (p in now) tree[p] = now[p]; else delete tree[p]; }
      const clash = clashes(tree);
      if (clash.length) refuse(400, {error: 'Filename collision with existing folder', path: clash[0]});
    }
    return {...await wholly(tree), ...changes(was, tree), size: flatBytes(tree) || 2};
  };

  /**
   * Record a commit on a line read at `row` (its head is the parent; read with lineAt's `commit`) and move the head to
   * it; with `draft`, the draft is laid down too. The commit is there before the line names it, its folders before it.
   * What the line's saves touched is of the new head from then: none, the draft being the commit; or, with `draft`,
   * each path where the draft differs from the commit. The caller holds the account's lock in a transaction: refused,
   * neither stays.
   */
  const commit = async (tx: Db, user: string, row: Line,
    w: {merged: string | null; modes: Modes; kind: string; title: string; issue: string; note: string; added: number; removed: number}, of: Of, draft?: {tree: Tree; modes: Modes}) => {
    const time = Date.now();
    const made = await madeOf(tx, row, of);
    const id = await cutId({repo: `${row.name}${row.line === 'main' ? '' : `@${row.line}`}`, parent: row.head, root: made.root, modes: w.modes, kind: w.kind, title: w.title,
      issue: w.issue, note: w.note, time});
    const nodes = JSON.stringify([...made.made].map(([nid, e]) => ({id: nid, e})));
    // main is what the servers a repo is shown in see (seen.ts reads what it pushed): a commit on main, or a change
    // merged into it, is pushed with it, so they see main's last commit, never an older one or nothing.
    const whole = 'draft' in of || !!draft;
    const touched = draft ? Object.keys({...draft.tree, ...('tree' in of ? of.tree : {})}).filter((p) => draft.tree[p] !== ('tree' in of ? of.tree[p] : undefined)) : [];
    // Touched paths are of the new head when they were of the old one, or when the commit is the draft (none then).
    const from = whole || (!!row.head && row.touchedFrom === row.head) ? id : null;
    // Its folders, the commit, and the line moved to it, in one statement: the line not where it was read, nothing stays.
    const [kept] = await rows<{bytes: number; moved: number}>(tx, sql`with nodes as (insert into tree_node (repo_id, id, user_id, entries)
          select ${row.id}, x.id, ${user}, x.e from jsonb_to_recordset(${nodes}::jsonb) as x(id text, e jsonb) on conflict do nothing returning bytes),
        made as (insert into cut (repo_id, id, user_id, parent, merged, tree, root, size, files, folders, modes, kind, title, issue, note, added, removed, time)
          values (${row.id}, ${id}, ${user}, ${row.head}, ${w.merged}, '{}'::jsonb, ${made.root}, ${made.size}, ${made.files},
            array(select jsonb_array_elements_text(${JSON.stringify(made.folders)}::jsonb)), ${JSON.stringify(w.modes)}::jsonb, ${w.kind}, ${w.title}, ${w.issue},
            ${w.note}, ${w.added}, ${w.removed}, ${new Date(time).toISOString()}::timestamptz)
          on conflict do nothing returning bytes),
        u as (update line set head = ${id}, ${row.line === 'main' ? sql`pushed = ${id}, ` : sql``}updated_at = now(),
            touched_from = ${from}${draft ? sql`, modes = ${JSON.stringify(modesFor(draft.tree, draft.modes))}::jsonb, version = ${row.version + 1}` : sql``}
          where repo_id = ${row.id} and name = ${row.line} and version = ${row.version} and head is not distinct from ${row.head} returning 1),
        g as (delete from line_touched where repo_id = ${row.id} and line = ${row.line} and ${whole} and exists (select 1 from u)
          and path not in (select jsonb_array_elements_text(${JSON.stringify(touched)}::jsonb))),
        i as (insert into line_touched (repo_id, line, path) select ${row.id}, ${row.line}, x from jsonb_array_elements_text(${JSON.stringify(touched)}::jsonb) x
          where exists (select 1 from u) on conflict do nothing)
      select coalesce((select sum(bytes) from nodes), 0)::float8 + coalesce((select bytes from made), 0) as bytes, (select count(*)::int from u) as moved`);
    if (!kept.moved) refuse(409, {head: row.head, version: row.version});
    if (row.used !== undefined) fitsUsed(row.used, Number(kept.bytes)); else await fits(tx, user, Number(kept.bytes));
    if (draft) await laid(tx, row.id, row.line, draft.tree);
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
    for (const v of Object.values(words)) if (typeof v !== 'string' || v.length > LIMIT.words) return c.json({error: 'Maximum 2000 characters'}, 400);
    if (!(words.title as string).trim()) return c.json({error: 'Commit title required'}, 400);
    const only = b.paths;
    if (only !== undefined && (!Array.isArray(only) || !only.length || only.length > LIMIT.diff || !only.every((p) => typeof p === 'string' && validPath(p)))) {
      return c.json({error: 'paths: Target paths for draft commit'}, 400);
    }
    const made = await db.transaction(async (tx: Db) => {
      await lock(tx, user);
      const row = await lineAt(tx, user, name, l, {commit: only ? true : 'draft'});
      on(row?.off);
      if (!row || row.version !== b.version || row.head !== b.parent) refuse(409, {head: row?.head ?? null, version: row?.version ?? 0});
      // Each path's mode as the draft has it (the draft keeps them of its files only), the rest as the head has them.
      let modes = row.modes ?? {};
      if (only) {
        modes = {...row.headModes ?? {}};
        for (const p of only as string[]) { if (p in (row.modes ?? {})) modes[p] = row.modes![p]; else delete modes[p]; }
      }
      return commit(tx, user, row, {merged: null, modes, ...(words as {kind: string; title: string; issue: string; note: string}),
        added: count(b.added), removed: count(b.removed)}, only ? {paths: [...new Set(only as string[])]} : {draft: true});
    });
    return c.json(made, 201);
  });

  v1.get('/repos/:name/cuts/:id', async (c) => {
    const id = c.req.param('id');
    if (!HEX.test(id)) return c.json({error: 'Commit not found'}, 404);
    const [row] = await db.select({...cutCols, off: repo.offAt}).from(cut).innerJoin(repo, eq(repo.id, cut.repoId))
      .where(and(eq(repo.userId, c.get('userId')), eq(repo.name, c.req.param('name')), eq(cut.id, id)));
    if (!row) return c.json({error: 'Commit not found'}, 404);
    on(row.off);
    const {off: _, ...shown} = row;
    return c.json({...shown, time: row.time.getTime()});
  });

  // What changed between two commits of a repo (`from` none: from nothing): each path whose value differs, as each has
  // it ({was, now}, a path absent from one where that one has none). Two with roots are compared folder by folder, every
  // folder they share skipped; one made before roots, by its tree whole, in the database (what is sent is what differs).
  // A device reads this where it read both trees whole.
  v1.get('/repos/:name/compare', async (c) => {
    const from = c.req.query('from') ?? '', to = c.req.query('to') ?? '';
    if ((from && !HEX.test(from)) || !HEX.test(to)) return c.json({error: 'Commit not found'}, 404);
    const r = await repoAt(db, c.get('userId'), c.req.param('name'));
    if (!r) return c.json({error: 'Commit not found'}, 404);
    on(r.off);
    const [k] = await rows<{ra: string | null; rb: string | null; fa: boolean; fb: boolean}>(db, sql`select a.root as ra, b.root as rb, a.id is not null as fa, b.id is not null as fb
      from (select 1) one left join cut a on a.repo_id = ${r.id} and a.id = ${from || null} left join cut b on b.repo_id = ${r.id} and b.id = ${to}`);
    if (!k.fb || (from && !k.fa)) return c.json({error: 'Commit not found'}, 404);
    const entries = (x: ReturnType<typeof sql>) => sql`jsonb_each(coalesce((select n.entries from tree_node n where n.repo_id = ${r.id} and n.id = ${x}), '{}'::jsonb))`;
    const differ = (!from || k.ra) && k.rb
      ? await rows<{path: string; had: boolean; was: string | null; has: boolean; now: string | null}>(db, sql`with recursive d(prefix, x, y) as (
            select ''::text, ${k.ra}::text, ${k.rb}::text
            union all
            select d.prefix || q.key || '/', q.xt, q.yt from d cross join lateral (
              select coalesce(ex.key, ey.key) as key, ex.value ->> 't' as xt, ey.value ->> 't' as yt
              from ${entries(sql`d.x`)} ex full join ${entries(sql`d.y`)} ey on ex.key = ey.key
              where (ex.value ->> 't') is distinct from (ey.value ->> 't')) q
            where d.x is distinct from d.y)
          select d.prefix || q.key as path, coalesce(q.ev ? 'f' or q.ev ? 'n', false) as had, q.ev ->> 'f' as was,
            coalesce(q.yv ? 'f' or q.yv ? 'n', false) as has, q.yv ->> 'f' as now
          from d cross join lateral (select coalesce(ex.key, ey.key) as key, ex.value as ev, ey.value as yv
            from ${entries(sql`d.x`)} ex full join ${entries(sql`d.y`)} ey on ex.key = ey.key) q
          where d.x is distinct from d.y and ((q.ev -> 'f') is distinct from (q.yv -> 'f') or coalesce(q.ev ? 'n', false) <> coalesce(q.yv ? 'n', false))`)
      : await rows<{path: string; had: boolean; was: string | null; has: boolean; now: string | null}>(db, sql`select coalesce(a.key, b.key) as path, a.key is not null as had,
            a.value #>> '{}' as was, b.key is not null as has, b.value #>> '{}' as now
          from jsonb_each(${from ? sql`cut_tree(${r.id}, ${from})` : sql`'{}'::jsonb`}) a full join jsonb_each(cut_tree(${r.id}, ${to})) b on a.key = b.key
          where a.value is distinct from b.value`);
    const was: Tree = {}, now: Tree = {};
    for (const x of differ) { if (x.had) was[x.path] = x.was; if (x.has) now[x.path] = x.now; }
    return c.json({was, now});
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
    const trees = summary ? sql`` : sql`cut_tree(c.repo_id, c.id) as tree, c.modes, `;
    const row = await lineAt(db, c.get('userId'), c.req.param('name'), lineOf(c));
    on(row?.off);
    if (!row?.head) return c.json([]);
    // With trees, no more of them than TREES_AT_ONCE as kept (each may be 8 MB; 50 were past what a Worker holds,
    // and every request on it failed with it): fewer commits, and the last one's parent says where the rest go on.
    const room = summary ? sql`` : sql`and w.held + coalesce(c.size, pg_column_size(c.tree)) < ${TREES_AT_ONCE}`;
    return c.json(await rows(db, sql`with recursive walk(id, n, held) as (
        select ${row.head}::text, 1, 0::bigint
        union all
        select c.parent, w.n + 1, w.held + coalesce(c.size, pg_column_size(c.tree)) from walk w join cut c on c.repo_id = ${row.id} and c.id = w.id
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
    if (!passkeyJustNow(g, c.get('sessionId'))) refuse(403, {error: 'Authenticate with passkey.'});
    if (b?.repo !== name) refuse(403, {error: 'Name does not match.'});
  };
  const named = (user: string, name: string) => and(eq(repo.userId, user), eq(repo.name, name));

  // Off: asks for a passkey just now and the repo's name.
  v1.post('/repos/:name/off', async (c) => {
    const user = c.get('userId'), name = c.req.param('name');
    await confirmed(c, name);
    // Off once: asking again does not restart its 30 days.
    const [done] = await db.update(repo).set({offAt: sql`coalesce(${repo.offAt}, now())`}).where(named(user, name)).returning({offAt: ms(sql`${repo.offAt}`)});
    if (!done) return c.json({error: 'Repo not found on Remote'}, 404);
    return c.json({name, offAt: done.offAt, until: done.offAt + KEPT});
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
      if (await repoAt(tx, user, name)) refuse(409, {error: 'Disable it first.'});
      refuse(404, {error: 'Repo not found on Remote'});
    });
    return c.json({name, discarded: true});
  });

  // On: back at once, as it was.
  v1.post('/repos/:name/on', async (c) => {
    const done = await db.update(repo).set({offAt: null}).where(named(c.get('userId'), c.req.param('name'))).returning({id: repo.id});
    return done.length ? c.json({name: c.req.param('name'), on: true}) : c.json({error: 'Repo not found on Remote'}, 404);
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
    if (!stem || !validLine(stem)) return c.json({error: 'Work must begin from an issue'}, 400);
    const {row, made} = await db.transaction(async (tx: Db) => {
      await lock(tx, user);
      const main = await lineAt(tx, user, name, 'main', {commit: 'draft'});
      if (!main) refuse(404, {error: 'Repo not found on Remote'});
      on(main.off);
      const existing = await lineAt(tx, user, name, stem);
      if (existing) return {row: existing, made: false};
      const [{n}] = await tx.select({n: sql<number>`count(*)::int`}).from(line).where(and(eq(line.repoId, main.id), ne(line.name, 'main')));
      if (n >= LIMIT.lines) refuse(429, {error: 'Too many open tasks in this repo'});
      // Work starts from what main last committed, not from main's uncommitted draft. A repo
      // nobody has committed yet gets its first commit (what it was made with) here, so the
      // work shows only what it changes.
      const head = main.head ?? (await commit(tx, user, main, {merged: null, modes: main.modes ?? {}, kind: '', title: 'Start', issue: '', note: '', added: 0, removed: 0},
        {draft: true})).id;
      // The issue itself comes along when main has it written but not committed: the work is about it (one row of the
      // draft read, not the draft).
      const cuts = await treesOf(tx, main.id, [head]);
      const from = {...cuts(head)};
      const [written] = await rows<{sha: string | null}>(tx, sql`select sha from line_file where repo_id = ${main.id} and line = 'main' and path = ${issue}`);
      const brought = !!written?.sha && !from[issue];
      if (brought) from[issue] = written.sha;
      await fits(tx, user, JSON.stringify(from).length);
      // What it changed since its head: the issue, if it came along.
      await tx.insert(line).values({repoId: main.id, userId: user, name: stem, base: head, head, pushed: head, modes: modesFor(from, cuts.modes(head)), version: 1,
        startedBy: whoBy(c), touchedFrom: head});
      await laid(tx, main.id, stem, from);
      if (brought) await tx.execute(sql`insert into line_touched (repo_id, line, path) values (${main.id}, ${stem}, ${issue})`);
      return {row: (await lineAt(tx, user, name, stem))!, made: true};
    });
    return c.json(lineShown(row), made ? 201 : 200);
  });

  // Push: the line's commits become visible as the line's state (what a change hands in).
  v1.post('/repos/:name/lines/:line/push', async (c) => {
    const user = c.get('userId'), name = c.req.param('name'), l = c.req.param('line');
    const b = await body<{head?: unknown}>(c);
    const row = await lineAt(db, user, name, l);
    if (!row) return c.json({error: 'Work not found on Remote'}, 404);
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
      if (!row) refuse(404, {error: 'Work not found on Remote'});
      on(row.off);
      if (!row.pushed || row.pushed !== row.head) refuse(409, {error: 'Push required: Changes reflect pushed commits', head: row.head, pushed: row.pushed});
      if (row.pushed === row.base) refuse(409, {error: 'No commits made yet'});
      if (!words.title || words.title.length > LIMIT.words || words.note.length > LIMIT.words || words.kind.length > LIMIT.words) refuse(400, {error: 'Change requires a title (max 2000 characters)'});
      const [was] = await tx.select({id: change.id, state: change.state, head: change.head, version: change.version}).from(change)
        .where(and(eq(change.repoId, row.id), eq(change.line, l)));
      if (was?.state === 'merged') refuse(409, {error: 'This Change is already merged'});
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
      if (!row) refuse(404, {error: 'Change not found'});
      on(row.off);
      if (b?.version !== row.version) refuse(409, {version: row.version});
      if (!['approve', 'changes', 'comment'].includes(String(b?.verdict))) refuse(400, {error: 'verdict'});
      if (row.reviews.length >= LIMIT.reviews) refuse(429, {error: 'Review limit reached for this Change'});
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
      if (!row) refuse(404, {error: 'Change not found'});
      on(row.off);
      if (row.state !== 'open') refuse(409, {error: 'This Change is no longer open', state: row.state});
      if (b?.version !== row.version) refuse(409, {version: row.version});
      const main = await lineAt(tx, user, name, 'main', {draft: true, commit: true});
      if (!main) refuse(404, {error: 'Repo not found on Remote'});
      const tree = await treesOf(tx, main.id, [row.base, main.head, row.head]);
      const merged = merge3(tree(row.base), tree(main.head), tree(row.head));
      if (merged.conflicts.length) refuse(409, {conflicts: merged.conflicts});
      // main's uncommitted draft keeps its own changes; what the merge brings is laid over it.
      const draft = merge3(tree(main.head), main.draft!, merged.tree);
      if (draft.conflicts.length) refuse(409, {conflicts: draft.conflicts, draft: true});
      // What main holds after is held to what any of its saves is (a repo of more files than it may hold would refuse every save after).
      for (const t of [merged.tree, draft.tree]) if (Object.keys(t).length > LIMIT.files || JSON.stringify(t).length > LIMIT.tree) refuse(413, {error: 'File limit reached for this repo'});
      // Modes are merged as the trees are; one both changed keeps main's (a mode is never what refuses a merge).
      const modes = modesFor(merged.tree, merge3(tree.modes(row.base), tree.modes(main.head), tree.modes(row.head)).tree);
      const draftModes = modesFor(draft.tree, merge3(tree.modes(main.head), main.modes ?? {}, modes).tree);
      const made = await commit(tx, user, main, {merged: row.head, modes, kind: row.kind, title: row.title, issue: issueOf(row.line), note: row.note, added: 0, removed: 0},
        {tree: merged.tree, from: tree(main.head)}, {tree: draft.tree, modes: draftModes});
      // Still open: a reject or reset that came between is not overwritten (and the merge is undone with this refusal).
      const done = await changed(tx, row.id, {state: 'merged', updatedAt: new Date()}, eq(change.state, 'open'));
      if (!done) refuse(409, {error: 'This Change is no longer open'});
      return {merged: made.id, ...changeShown(name, done)};
    });
    return c.json(out);
  });

  // Reject (the receiver does not take it) and Reset (the one who submitted it takes it back).
  for (const [verb, state] of [['reject', 'rejected'], ['reset', 'reset']] as const) {
    v1.post(`/repos/:name/changes/:id/${verb}`, async (c) => {
      const user = c.get('userId'), name = c.req.param('name');
      const row = await changeAt(db, user, name, c.req.param('id'));
      if (!row) return c.json({error: 'Change not found'}, 404);
      on(row.off);
      const b = await body<{note?: unknown}>(c);
      const note = typeof b?.note === 'string' && b.note ? {note: b.note.slice(0, LIMIT.words)} : {};
      const done = row.state === 'open' && await changed(db, row.id, {state, ...note, updatedAt: new Date()}, eq(change.state, 'open'));
      return done ? c.json(changeShown(name, done)) : c.json({error: 'This Change is no longer open', state: (await changeAt(db, user, name, row.id))?.state ?? row.state}, 409);
    });
  }
}
