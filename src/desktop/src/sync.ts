// The canonical copy is on the Remote (remote/remote.ts); what is here is a
// checkout, trusted only as far as it matches what the Remote holds. For
// each repo this copy remembers the cut it came from (its base) and that
// cut's tree, so it can always say which state it is in:
//
//   pushed   the files are the base's: nothing here is not on the Remote
//   unpushed files differ from the base: the only state that can be lost
//   behind   the Remote has moved past the base (another device pushed)
//   local    never pushed (or no Remote): it is only here
//
// 区切る is the push: a cut is made of the repo's whole tree, files the
// Remote lacks go first, and the head moves only from the base. Taking in
// (pull) is file by file against the base, and never overwrites a file
// changed here: when both sides changed one, nothing is taken.
// Whatever comes from the Remote is checked against its name.

import {getState, setState, type Key} from './state.ts';
import {store} from './repos.ts';

export const REMOTE_URL: string =
  (import.meta as {env?: Record<string, string>}).env?.VITE_LENGTH3_REMOTE ?? 'https://remote.length3.com';

interface Connection { url: string; token: string }
interface Base { cut: string; tree: Record<string, string | null> }
/** A setting as last agreed with the Remote: its version there and its text. */
interface HomeBase { etag: string; json: string }
interface SyncState { repos: Record<string, Base>; home?: Record<string, HomeBase> }

export type RepoState = {state: 'pushed' | 'unpushed' | 'behind' | 'local'; changed: number; head?: string};

export interface RemoteCut { id: string; repo: string; parent: string | null; tree: Record<string, string | null>; kind: string; title: string; issue: string; note: string; time: number }

const enc = new TextEncoder(), dec = new TextDecoder();
const BY = 'sync';

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const read = <T>(key: 'remote' | 'sync', empty: T): T => {
  try { return JSON.parse(getState(key) ?? '') as T; } catch { return empty; }
};
export const connection = (): Connection | null => read<Connection | null>('remote', null);
const syncState = (): SyncState => read<SyncState>('sync', {repos: {}});
const saveSync = (s: SyncState) => setState('sync', JSON.stringify(s));

export class RemoteError extends Error {
  readonly status: number;
  readonly detail: Record<string, unknown>;
  constructor(status: number, message: string, detail: Record<string, unknown> = {}) { super(message); this.status = status; this.detail = detail; }
}

async function call(path: string, init: RequestInit = {}, c = connection()): Promise<Response> {
  if (!c) throw new RemoteError(0, 'Remote につながっていません');
  const r = await fetch(c.url + path, {...init, headers: {Authorization: `Bearer ${c.token}`, ...(init.headers ?? {})}});
  if (r.status >= 400 && r.status !== 409 && r.status !== 404 && r.status !== 412) {
    throw new RemoteError(r.status, r.status === 401 ? 'Remote がこのアカウントを知りません' : `Remote: ${r.status}`);
  }
  return r;
}

/** Make an account on the Remote and remember it here; the token is the only key to it. */
export async function signUp(url = REMOTE_URL): Promise<string> {
  const r = await fetch(`${url}/v1/accounts`, {method: 'POST'});
  if (!r.ok) throw new RemoteError(r.status, `Remote: ${r.status}`);
  const {token} = await r.json() as {token: string};
  await connect(token, url);
  return token;
}

/** Use an existing account (its token) from this device. */
export async function connect(token: string, url = REMOTE_URL) {
  const c = {url, token: token.trim()};
  const r = await call('/v1/repos', {}, c);
  if (!r.ok) throw new RemoteError(r.status, 'Remote がこのアカウントを知りません');
  await setState('remote', JSON.stringify(c));
}

/** Forget the account here (nothing on the Remote changes). */
export async function disconnect() { await setState('remote', 'null'); }

/** The repo's files as the Remote would hold them: path -> sha256 (null: an empty folder). */
export async function treeOf(repo: string): Promise<{tree: Record<string, string | null>; blobs: Map<string, Uint8Array>; skipped: string[]}> {
  const tree: Record<string, string | null> = {};
  const blobs = new Map<string, Uint8Array>();
  const skipped: string[] = [];
  const walk = async (dir: string) => {
    const entries = await store.tree(repo, dir);
    if (dir && !entries.length) tree[dir] = null;
    for (const e of entries) {
      const path = dir ? `${dir}/${e.name}` : e.name;
      if (e.kind === 'dir') { await walk(path); continue; }
      if (e.kind !== 'file') continue;
      const c = await store.read(repo, path).catch(() => null);
      // Only text travels for now; what does not is named, never dropped silently.
      if (!c || c.text === null || c.truncated) { skipped.push(path); continue; }
      const bytes = enc.encode(c.text);
      const sha = await sha256(bytes);
      tree[path] = sha;
      blobs.set(sha, bytes);
    }
  };
  await walk('');
  return {tree, blobs, skipped};
}

/** Paths whose content differs between two trees. */
export function differ(a: Record<string, string | null>, b: Record<string, string | null>): string[] {
  const out = new Set<string>();
  for (const p of Object.keys(a)) if (a[p] !== b[p]) out.add(p);
  for (const p of Object.keys(b)) if (!(p in a)) out.add(p);
  return [...out].sort();
}

/** Every repo's state against the Remote, in one read of its heads. */
export async function states(): Promise<Map<string, RepoState>> {
  const out = new Map<string, RepoState>();
  const s = syncState();
  const heads = connection() ? await remoteRepos().catch(() => null) : null;
  for (const r of await store.list()) {
    const base = s.repos[r.name];
    const {tree} = await treeOf(r.name);
    const changed = base ? differ(tree, base.tree).length : Object.keys(tree).length;
    const head = heads?.find((h) => h.name === r.name)?.head;
    const state: RepoState['state'] = !base ? 'local' : changed ? 'unpushed' : head && head !== base.cut ? 'behind' : 'pushed';
    out.set(r.name, {state, changed, head});
  }
  return out;
}

export async function remoteRepos(): Promise<{name: string; head: string; time: number; title: string; kind: string}[]> {
  return (await call('/v1/repos')).json();
}

export async function remoteLog(repo: string): Promise<RemoteCut[]> {
  const r = await call(`/v1/repos/${encodeURIComponent(repo)}/log?limit=50`);
  return r.status === 404 ? [] : r.json();
}

/**
 * 区切る as a push: the repo's whole tree, files the Remote lacks first,
 * then the cut from the base. Refused when the Remote has moved on.
 */
export async function push(repo: string, words: {kind: string; title: string; issue: string; note: string}): Promise<{id: string; skipped: string[]}> {
  const s = syncState();
  const base = s.repos[repo] ?? null;
  const {tree, blobs, skipped} = await treeOf(repo);
  const missing = await (await call('/v1/blobs/missing', {method: 'POST', body: JSON.stringify([...blobs.keys()])})).json() as string[];
  for (const sha of missing) {
    const r = await call(`/v1/blobs/${sha}`, {method: 'PUT', body: blobs.get(sha) as BodyInit});
    if (!r.ok) throw new RemoteError(r.status, `Remote が受け取りませんでした（${r.status}）`);
  }
  const r = await call(`/v1/repos/${encodeURIComponent(repo)}/cuts`, {method: 'POST', body: JSON.stringify({parent: base?.cut ?? null, tree, ...words})});
  if (r.status === 409) {
    const detail = await r.json() as Record<string, unknown>;
    throw new RemoteError(409, 'head' in detail ? 'Remote が先に進んでいます。先に取り込んでください' : 'Remote にないファイルがあります', detail);
  }
  const {id} = await r.json() as {id: string};
  s.repos[repo] = {cut: id, tree};
  await saveSync(s);
  return {id, skipped};
}

/** The cut and tree this copy of `repo` came from, if it came from one. */
export const baseOf = (repo: string): Base | null => syncState().repos[repo] ?? null;

const texts = new Map<string, string>();
/** A file's text on the Remote by its name, checked; kept for the page. */
export async function blobText(sha: string): Promise<string> {
  const known = texts.get(sha);
  if (known !== undefined) return known;
  const t = await blob(sha);
  texts.set(sha, t);
  return t;
}

async function blob(sha: string): Promise<string> {
  const r = await call(`/v1/blobs/${sha}`);
  if (!r.ok) throw new RemoteError(r.status, `Remote にないファイル ${sha.slice(0, 12)}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  // Trusted only as far as it is what its name says.
  if (await sha256(bytes) !== sha) throw new RemoteError(0, 'Remote から届いたものが名前と合いません');
  return dec.decode(bytes);
}

let taken: ((repo: string, cut: RemoteCut) => Promise<void>) | null = null;
/** Run after a cut was taken into a repo here (the app records it in the repo's git). */
export function afterTake(fn: (repo: string, cut: RemoteCut) => Promise<void>) { taken = fn; }

/** What taking in found: files both sides changed differently. */
export class Conflict extends RemoteError {
  readonly paths: string[];
  constructor(paths: string[]) { super(409, `両方で変わったファイルがあります: ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ' …' : ''}`); this.paths = paths; }
}

/**
 * Take in the Remote's head, file by file against the base: a file only the
 * Remote changed is taken, one only changed here is kept, and if any file
 * changed on both sides differently nothing is taken and they are named.
 * The head becomes the base; what is kept here is then unpushed, and the
 * next 区切る pushes it on top.
 */
export async function pull(repo: string): Promise<'same' | 'taken' | 'none'> {
  const r = await call(`/v1/repos/${encodeURIComponent(repo)}`);
  if (r.status === 404) return 'none';
  const cut = await r.json() as RemoteCut;
  const s = syncState();
  const base = s.repos[repo]?.tree ?? {};
  if (s.repos[repo]?.cut === cut.id) return 'same';
  const exists = (await store.list()).some((x) => x.name === repo);
  const here = exists ? (await treeOf(repo)).tree : {};
  const take: string[] = [], conflicts: string[] = [];
  for (const path of new Set([...Object.keys(here), ...Object.keys(cut.tree)])) {
    const b = base[path], l = here[path], t = cut.tree[path];
    if (l === t || t === b) continue; // the same, or only changed here
    if (l === b) take.push(path); // only changed there
    else conflicts.push(path);
  }
  if (conflicts.length) throw new Conflict(conflicts.sort());
  if (!exists) await store.create(repo, 'empty', BY);
  const now = (await treeOf(repo)).tree;
  // A new repo starts with the template's README; the head decides about it too.
  if (!exists) for (const p of Object.keys(now)) if (!(p in cut.tree) && !take.includes(p)) take.push(p);
  for (const path of take.sort()) {
    const sha = cut.tree[path];
    if (sha === undefined) { await store.remove(repo, path, BY).catch(() => {}); continue; }
    if (sha === null) { await store.mkdir(repo, path, BY).catch(() => {}); continue; }
    const text = await blob(sha);
    const at = path.lastIndexOf('/');
    const dir = at < 0 ? '' : path.slice(0, at);
    if (path in now) await store.write(repo, path, text, BY);
    else {
      if (dir) await store.mkdir(repo, dir, BY).catch(() => {});
      await store.add(repo, dir, path.slice(at + 1), text, BY);
    }
  }
  s.repos[repo] = {cut: cut.id, tree: cut.tree};
  await saveSync(s);
  await taken?.(repo, cut);
  return 'taken';
}

/** Take in every repo the Remote has that is not ahead here; say what could not be. */
export async function pullAll(): Promise<{taken: string[]; refused: string[]}> {
  const taken: string[] = [], refused: string[] = [];
  for (const r of await remoteRepos()) {
    try { if (await pull(r.name) === 'taken') taken.push(r.name); } catch (e) { if (e instanceof Conflict) refused.push(r.name); else throw e; }
  }
  return {taken, refused};
}

/** Repos whose copy here holds nothing the Remote lacks: these may go when the tab closes. */
export async function pushedRepos(): Promise<string[]> {
  if (!connection()) return [];
  const s = syncState();
  const out: string[] = [];
  for (const r of await store.list()) {
    const base = s.repos[r.name];
    if (base && !differ((await treeOf(r.name)).tree, base.tree).length) out.push(r.name);
  }
  return out;
}

/** Forget a repo's base here (its copy was let go). */
export async function forget(repo: string) {
  const s = syncState();
  delete s.repos[repo];
  await saveSync(s);
}

/** Home's settings that are the person's, not this device's (the band is the device's). */
export const HOME_KEYS = ['profile', 'todo'] as const satisfies readonly Key[];
type HomeKey = typeof HOME_KEYS[number];

export type HomeState = 'pushed' | 'unpushed' | 'conflict' | 'local';

/** Whether a setting here is what the Remote has. */
export function homeState(key: HomeKey): HomeState {
  const b = syncState().home?.[key];
  const here = getState(key);
  if (!b) return here === null ? 'pushed' : 'local';
  return here === null || here === b.json ? 'pushed' : 'unpushed';
}

/**
 * Agree a setting with the Remote. Unchanged here: take the Remote's.
 * Changed here: push it from the version it was read at; if the Remote
 * moved meanwhile, keep both as they are and say so.
 */
export async function syncHome(key: HomeKey): Promise<HomeState> {
  const s = syncState();
  s.home ??= {};
  const b = s.home[key];
  const here = getState(key);
  const r = await call(`/v1/home/${key}`);
  const there = r.status === 204 || r.status === 404 ? null : {json: await r.text(), etag: r.headers.get('ETag') ?? ''};
  const changedHere = here !== null && here !== b?.json;
  if (!changedHere) {
    if (there && there.json !== here) await setState(key, there.json);
    if (there) s.home[key] = there;
    await saveSync(s);
    return 'pushed';
  }
  if (there && b && there.etag !== b.etag) return 'conflict';
  if (there && !b && there.json !== here) return 'conflict';
  const put = await call(`/v1/home/${key}`, {method: 'PUT', body: here,
    headers: {'Content-Type': 'application/json', ...(there ? {'If-Match': there.etag} : {'If-None-Match': '*'})}});
  if (put.status === 412) return 'conflict';
  s.home[key] = {etag: put.headers.get('ETag') ?? '', json: here};
  await saveSync(s);
  return 'pushed';
}
