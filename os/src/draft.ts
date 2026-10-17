// Each repo here kept in step with its draft on the Remote (service/app.ts),
// a diff at a time; the same model as core/src/remote.rs, which the app
// uses through its commands. In a browser it is done here, on the browser's
// copy (repos.ts), which holds text: a file that is not text stays on the
// Remote only ("away") and is never removed from it by this copy.
//
// Taking in is file by file against the last version agreed with the
// Remote: a file only changed there is written here, one only changed here
// is sent, and when both changed one, the version the Remote has (it got
// there first) keeps the name and this device's is kept beside it, named
// after this device ("name (Chrome Linux).ext"), so the name says whose it is
// on every device.

import {t} from './i18n.ts';
import {isNative, native} from './host.ts';
import {api, deviceWord, json, RemoteError} from './remote.ts';
import {store} from './repos.ts';
import {getState, setState} from './state.ts';

export type Tree = Record<string, string | null>;

export interface Synced { version: number; sent: number; taken: number; both: string[]; unsynced: [string, string][] }
export interface Status { name: string; changed: number; fresh: boolean; unsynced: [string, string][]; bytes: number; head: string | null; version: number }
/** A repo on the Remote; one turned off says when it went and until when it can come back. */
export interface RemoteRepo { name: string; head: string | null; version: number; bytes: number; updatedAt: string; offAt?: number | null; until?: number | null }

interface Base { version: number; tree: Tree; head: string | null; away?: string[] }
interface SyncState { repos: Record<string, Base>; home?: Record<string, {version: number; value: string}>; lines?: Record<string, string> }

/** Whoever writes on sync's behalf, so listeners can tell its writes from a person's. */
export const BY = 'sync';
const CHUNK = 2000;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true});

export async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const syncState = (): SyncState => {
  // None kept yet (or not readable): nothing is agreed, and every repo is taken in afresh.
  try { const s = JSON.parse(getState('sync') ?? '') as SyncState; return {...s, repos: s.repos ?? {}}; } catch { return {repos: {}}; }
};
const saveState = (s: SyncState) => setState('sync', JSON.stringify(s));
/** The line a repo shows (main, or an issue's work), and the key its agreement is kept under. */
export const lineOf = (repo: string): string => (isNative ? 'main' : store.lineOf(repo));
export const keyOf = (repo: string, line = lineOf(repo)) => (line === 'main' ? repo : `${repo}@${line}`);
/** The Remote's address of what the repo shows: the repo, and its line when not main. */
export const at = (repo: string, rest = '', line = lineOf(repo)) =>
  `/v1/repos/${encodeURIComponent(repo)}${rest}${line === 'main' ? '' : `${rest.includes('?') ? '&' : '?'}line=${encodeURIComponent(line)}`}`;
export const baseOf = (repo: string): Base | null => syncState().repos[keyOf(repo)] ?? null;
async function setBase(repo: string, b: Base | null) {
  repo = keyOf(repo);
  const s = syncState();
  if (b) s.repos[repo] = b; else delete s.repos[repo];
  await saveState(s);
}

// ---- merging (as remote.rs) ----

export interface Plan { take: [string, string | null | undefined][]; both: [string, string][] }

/** undefined: absent; null: an empty folder; a string: a file's digest. */
export function plan(base: Tree, here: Tree, there: Tree): Plan {
  const p: Plan = {take: [], both: []};
  const get = (t: Tree, k: string) => (k in t ? t[k] : undefined);
  for (const path of [...new Set([...Object.keys(base), ...Object.keys(here), ...Object.keys(there)])].sort()) {
    const b = get(base, path), l = get(here, path), r = get(there, path);
    if (l === r || r === b) continue;
    if (l === b || (l === undefined && r !== undefined)) p.take.push([path, r]);
    else if (typeof r === 'string') p.both.push([path, r]);
  }
  return p;
}

/** "dir/name (who).ext" beside `path`; the n'th such is "(who n)". */
export function beside(path: string, who = 'other device', n = 1): string {
  const at = path.lastIndexOf('/');
  const dir = at < 0 ? '' : path.slice(0, at + 1), file = path.slice(at + 1);
  const dot = file.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ''];
  return `${dir}${stem} (${who}${n > 1 ? ` ${n}` : ''})${ext}`;
}

/** This device as a file's name can carry it: what the Remote page calls it, its words alone. */
export const deviceTag = (ua = globalThis.navigator?.userAgent): string =>
  deviceWord(ua).normalize('NFKC').replace(/[^\p{L}\p{N} ._-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'this device';

// ---- the browser's copy ----

interface Local { tree: Tree; texts: Map<string, string>; bytes: number }

/**
 * Whether a directory is derived: made from the repo's own files by a tool
 * that makes it again from them (core/src/owned.rs `derived`, the same
 * rule). Its lifetime is its sources', so it is not the repo's to send.
 * Known by proof: it says it is a cache (CACHEDIR.TAG), or it is a tool's
 * usual directory beside the file it is made from.
 */
export function derived(name: string, siblings: ReadonlySet<string>, inside: ReadonlySet<string>): boolean {
  if (inside.has('CACHEDIR.TAG')) return true;
  switch (name) {
    case 'node_modules': case '.next': case '.nuxt': case '.svelte-kit': case '.parcel-cache': case '.turbo': return siblings.has('package.json');
    case 'target': return siblings.has('Cargo.toml');
    case '.venv': case 'venv': return inside.has('pyvenv.cfg');
    case '__pycache__': case '.pytest_cache': case '.mypy_cache': case '.ruff_cache': case '.tox': return true;
    case '.gradle': return ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].some((f) => siblings.has(f));
    case '.zig-cache': case 'zig-cache': case 'zig-out': return siblings.has('build.zig');
    default: return false;
  }
}

/**
 * Each copy's digests as its files were last read, by their text: a file is
 * digested again only when its text is another (as core's digest() is by a
 * file's size, time and inode), not at every look.
 */
const digests = new Map<string, Map<string, {text: string; sha: string; size: number}>>();

async function localTree(repo: string, away: string[] = [], base: Tree = {}): Promise<Local> {
  const tree: Tree = {}, texts = new Map<string, string>();
  const key = keyOf(repo), was = digests.get(key), now: NonNullable<typeof was> = new Map();
  let bytes = 0;
  const walk = async (dir: string, entries: Awaited<ReturnType<typeof store.tree>>) => {
    if (dir && !entries.length) tree[dir] = null;
    const names = new Set(entries.map((e) => e.name));
    for (const e of entries) {
      const path = dir ? `${dir}/${e.name}` : e.name;
      if (e.kind === 'dir') {
        const inside = await store.tree(repo, path);
        if (!derived(e.name, names, new Set(inside.map((x) => x.name)))) await walk(path, inside);
        continue;
      }
      // Gone between listing it and reading it: not part of this tree.
      const c = await store.read(repo, path).catch(() => null);
      if (!c || c.text === null) continue;
      let d = was?.get(path);
      if (d?.text !== c.text) { const b = enc.encode(c.text); d = {text: c.text, sha: await sha256(b), size: b.length}; }
      now.set(path, d);
      tree[path] = d.sha;
      texts.set(d.sha, c.text);
      bytes += d.size;
    }
  };
  await walk('', await store.tree(repo, ''));
  // Only what is here now is remembered: a file gone takes its digest with it.
  digests.set(key, now);
  // What this copy cannot hold stays as the Remote has it.
  for (const p of away) if (!(p in tree) && base[p] !== undefined) tree[p] = base[p];
  return {tree, texts, bytes};
}

const blobs = new Map<string, string | null>();
/** A file's text on the Remote by its digest (null: not text), checked against its name. */
export async function blobText(sha: string): Promise<string | null> {
  if (blobs.has(sha)) return blobs.get(sha)!;
  const r = await api(`/v1/blobs/${sha}`);
  if (!r.ok) throw new RemoteError(r.status, t('The Remote has no file {sha}', {sha: sha.slice(0, 12)}));
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (await sha256(bytes) !== sha) throw new RemoteError(0, t('What came from the Remote is not what its name says'));
  let text: string | null;
  try { text = dec.decode(bytes); } catch { text = null; } // not UTF-8: not text, and it stays on the Remote
  if (bytes.length < 1 << 20) blobs.set(sha, text);
  return text;
}

/** Write the Remote's side of `p`; returns the paths now away and those set beside. */
async function apply(repo: string, p: Plan, away: Set<string>): Promise<string[]> {
  const aside: string[] = [];
  // Already gone (taken with its folder before it, or never here): nothing to take. Still here: said.
  const gone = (path: string) => store.remove(repo, path, BY).catch(async (e: unknown) => {
    if (await store.read(repo, path).then(() => true, () => false)) throw e;
  });
  const write = async (path: string, sha: string) => {
    const text = await blobText(sha);
    if (text === null) { await gone(path); away.add(path); return; }
    away.delete(path);
    await store.put(repo, path, text, BY);
  };
  for (const [path, what] of p.take) {
    if (what === undefined) { away.delete(path); await gone(path); continue; }
    if (what === null) {
      // An empty folder that a file here is in the way of: the file stays, and that is said.
      if (!await store.put(repo, path, null, BY).then(() => true, () => false)) aside.push(path);
      continue;
    }
    try { await write(path, what); } catch (e) {
      // Not to be had now (offline): the sync stops and is tried again; nothing is agreed meanwhile.
      if (e instanceof RemoteError) throw e;
      // Something here is in its way (a folder for a file, a file for a folder): beside it. If that
      // fails too, the sync fails and says so, rather than agree a tree this copy does not have.
      await write(beside(path), what);
      aside.push(path);
    }
  }
  for (const [path, theirs] of p.both) {
    // The Remote's keeps the name (it got there first); this device's is kept beside it first, under
    // this device's name, so neither is lost if writing the other fails.
    const mine = (await store.read(repo, path)).text;
    if (mine !== null) {
      let n = 1;
      while (await store.read(repo, beside(path, deviceTag(), n)).then(() => true, () => false)) n++;
      await store.put(repo, beside(path, deviceTag(), n), mine, BY);
      await write(path, theirs);
    } else await write(beside(path), theirs);
    aside.push(path);
  }
  return aside;
}

const running = new Map<string, Promise<unknown>>();
/** One sync of a repo at a time. */
function serial<T>(repo: string, f: () => Promise<T>): Promise<T> {
  // The one before failing is its own caller's to hear; this one runs all the same.
  const next = (running.get(repo) ?? Promise.resolve()).catch(() => undefined).then(f);
  running.set(repo, next);
  // The caller hears this one's failure from `next`; the bookkeeping beside it must not raise it twice.
  void next.finally(() => { if (running.get(repo) === next) running.delete(repo); }).catch(() => undefined);
  return next;
}

async function webSync(repo: string): Promise<Synced> {
  const out: Synced = {version: 0, sent: 0, taken: 0, both: [], unsynced: []};
  const path = at(repo);
  for (let round = 0; round < 12; round++) {
    const base = baseOf(repo) ?? {version: 0, tree: {}, head: null};
    const here = await localTree(repo, base.away, base.tree);
    const r = await api(path);
    const there = r.status === 404 ? null : await r.json() as {version: number; draft: Tree; head: string | null};
    const remoteVersion = there?.version ?? 0;
    if (remoteVersion !== base.version) {
      const tree = there?.draft ?? {};
      const p = plan(base.tree, here.tree, tree);
      const away = new Set(base.away ?? []);
      out.both.push(...await apply(repo, p, away));
      out.taken += p.take.length;
      await setBase(repo, {version: remoteVersion, tree, head: there?.head ?? null, away: [...away].filter((a) => a in tree)});
      continue;
    }
    const set = Object.entries(here.tree).filter(([p, v]) => !(p in base.tree) || base.tree[p] !== v).slice(0, CHUNK);
    const remove = Object.keys(base.tree).filter((p) => !(p in here.tree)).slice(0, CHUNK);
    if (!set.length && !remove.length) { out.version = base.version; return out; }
    const shas = [...new Set(set.map(([, v]) => v).filter((v): v is string => typeof v === 'string'))];
    if (shas.length) {
      const missing = await json<string[]>('/v1/blobs/missing', {method: 'POST', body: JSON.stringify(shas)});
      for (const sha of missing) {
        const text = here.texts.get(sha);
        if (text === undefined) continue;
        const put = await api(`/v1/blobs/${sha}`, {method: 'PUT', body: enc.encode(text) as BodyInit, headers: {'Content-Type': 'application/octet-stream'}});
        if (!put.ok) throw new RemoteError(put.status, put.status === 507 ? t('The Remote is full for this account') : t('The Remote did not take it ({status})', {status: put.status}));
      }
    }
    const patched = await api(at(repo, '/draft'), {method: 'PATCH', body: JSON.stringify({version: base.version, set: Object.fromEntries(set), remove})});
    if (patched.status !== 200) continue; // someone else moved it, or a blob went missing: once more
    const {version} = await patched.json() as {version: number};
    const tree = {...base.tree};
    for (const p of remove) { delete tree[p]; for (const q of Object.keys(tree)) if (q.startsWith(`${p}/`)) delete tree[q]; }
    for (const [p, v] of set) tree[p] = v;
    out.sent += set.length + remove.length;
    out.version = version;
    await setBase(repo, {...base, version, tree});
  }
  return out;
}

// ---- what the shell uses, on either host ----

/** Send what changed here and take in what changed there, until both are the same. */
export const sync = (repo: string): Promise<Synced> =>
  isNative ? native<Synced>('sync_repo', {repo}) : serial(repo, () => webSync(repo));

/** Bring a repo that is only on the Remote here (opening it does this). */
export async function fetchRepo(repo: string): Promise<Synced> {
  if (isNative) return native<Synced>('repo_fetch', {repo});
  if (!(await store.list()).some((r) => r.name === repo)) {
    await setBase(repo, null);
    await store.create(repo, '', BY);
  }
  return sync(repo);
}

export const remoteRepos = (): Promise<RemoteRepo[]> => (isNative ? native<RemoteRepo[]>('remote_repos') : json<RemoteRepo[]>('/v1/repos'));

/** What moved on the Remote, in one small read: a stamp of its repos (the list changes when it does) and each setting's version. */
export interface Moved { repos: string; home: Record<string, number> }
export const moved = () => json<Moved>('/v1/moved');

/** Where each repo here stands, from what is here alone. */
export async function status(): Promise<Status[]> {
  if (isNative) return native<Status[]>('remote_status');
  const out: Status[] = [];
  for (const r of await store.list()) {
    const b = baseOf(r.name);
    const here = await localTree(r.name, b?.away, b?.tree);
    const changed = b ? [...new Set([...Object.keys(here.tree), ...Object.keys(b.tree)])].filter((p) => here.tree[p] !== b.tree[p]).length : Object.keys(here.tree).length;
    out.push({name: r.name, changed, fresh: !b, unsynced: [], bytes: here.bytes, head: b?.head ?? null, version: b?.version ?? 0});
  }
  return out;
}

/** The copy here has gone (freed, or left with the page): forget what was agreed for it. */
export async function forget(repo: string, keepLine = false) {
  const s = syncState();
  for (const k of Object.keys(s.repos)) if (k === repo || k.startsWith(`${repo}@`)) delete s.repos[k];
  for (const k of [...digests.keys()]) if (k === repo || k.startsWith(`${repo}@`)) digests.delete(k);
  if (s.lines && !keepLine) delete s.lines[repo];
  await saveState(s);
}

/** Which work each repo showed, so a reload shows it again (a browser's copy). */
export function restoreLines() {
  if (isNative) return;
  for (const [repo, line] of Object.entries(syncState().lines ?? {})) store.showLine(repo, line);
}

/** Show `line`'s work as `repo` here; its copy comes from the Remote when it is not here yet. */
export async function showLine(repo: string, line: string): Promise<void> {
  if (isNative) { await native('work_switch', {repo, line}); store.changedOutside(repo, 'work'); return; }
  // Offline, the copy shown so far stays here with what it has not sent (sent when it is shown again).
  await sync(repo).catch((e: unknown) => { if (!(e instanceof RemoteError)) throw e; });
  const made = store.showLine(repo, line);
  const s = syncState();
  s.lines = {...s.lines};
  if (line === 'main') delete s.lines[repo]; else s.lines[repo] = line;
  if (made) delete s.repos[keyOf(repo, line)];
  await saveState(s);
  await sync(repo);
}

/** The head this copy is on, and that cut's tree (empty before the first). */
export async function headTree(repo: string): Promise<Tree> {
  const head = baseOf(repo)?.head;
  if (!head) return {};
  const c = await json<{tree: Tree}>(`/v1/repos/${encodeURIComponent(repo)}/cuts/${head}`);
  return c.tree;
}

/** A commit's tree, by its id (any line of the repo). */
export async function treeAt(repo: string, id: string | null): Promise<Tree> {
  if (!id) return {};
  const c = await json<{tree: Tree}>(`/v1/repos/${encodeURIComponent(repo)}/cuts/${id}`);
  return c.tree;
}

/** A cut was made at the agreed version: it is the head now. */
export async function setHead(repo: string, head: string | null) {
  const b = baseOf(repo);
  if (b) await setBase(repo, {...b, head});
}

// ---- Home's settings that are the person's (the band is the device's) ----

export const HOME_KEYS = ['profile', 'todo', 'dotfiles'] as const;
export type HomeKey = typeof HOME_KEYS[number];

/** Two TODO lists as one: every item from both, this device's where both have it. */
function mergeTodo(here: string, there: string): string {
  try {
    const a = JSON.parse(here) as {id: string}[], b = JSON.parse(there) as {id: string}[];
    const ids = new Set(a.map((x) => x.id));
    return JSON.stringify([...b.filter((x) => !ids.has(x.id)), ...a]);
  } catch { return here; } // one side is not a list: this device's stands
}

/** Whether a setting needs agreeing: its version on the Remote moved, or its value here is not the one agreed. */
export function homeMoved(key: HomeKey, version: number): boolean {
  const b = syncState().home?.[key];
  return version !== (b?.version ?? 0) || (getState(key) ?? '') !== (b?.value ?? '');
}

/**
 * Agree a setting with the Remote. Unchanged here: the Remote's is taken.
 * Changed here: it is sent from the version it was read at; if another
 * device changed it meanwhile, the TODO lists are joined and the profile
 * is the Remote's. l3 agrees them the same way, in the same record
 * (core/src/home.rs), so the app and l3 on one device are one device.
 */
export async function syncHome(key: HomeKey): Promise<void> {
  for (let round = 0; round < 3; round++) {
    const s = syncState();
    const b = s.home?.[key];
    const here = getState(key);
    const there = await json<{value: string | null; version: number}>(`/v1/home/${key}`);
    const changedHere = here !== null && here !== b?.value;
    if (!changedHere) {
      if (there.value !== null && there.value !== here) await setState(key, there.value);
      await saveState({...syncState(), home: {...syncState().home, [key]: {version: there.version, value: there.value ?? here ?? ''}}});
      return;
    }
    let value = here!;
    if (there.version !== (b?.version ?? 0) && there.value !== null) {
      if (key !== 'todo') {
        // The Remote's stands, and is what is agreed now (bug: taken but never agreed, so it was taken again at every look).
        await setState(key, there.value);
        await saveState({...syncState(), home: {...syncState().home, [key]: {version: there.version, value: there.value}}});
        return;
      }
      value = mergeTodo(here!, there.value);
      if (value !== here) await setState(key, value);
    }
    const r = await api(`/v1/home/${key}`, {method: 'PUT', body: JSON.stringify({value, version: there.version})});
    const done = await r.json() as {version: number; value?: string};
    if (r.status === 200 || r.status === 201) {
      await saveState({...syncState(), home: {...syncState().home, [key]: {version: done.version, value}}});
      return;
    }
  }
}
