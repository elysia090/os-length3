// Servers on the Remote (service/servers.ts): groups of people who know
// each other, whose boards each hold a plan written together and the talk
// around it. The one thing whose subject is people, not a repo.
//
// A board's talk is pages, each the range of ids it was read as (its newest
// and oldest). A page's posts can be let go of and read again by that range
// (the same posts, less any taken down), so what a reader holds stays about
// what is near the screen however far they scroll.

import {api, connection, json, RemoteError} from './remote.ts';
import {hunks, lines} from './plan.ts';
import {t} from './i18n.ts';

export interface BoardRef { id: string; name: string; open: boolean; guests: boolean }
/** A server: what it is called, and its name as a principal (name@domain, in the namespace people's addresses are in). */
export interface Server { id: string; name: string; address: string; owner: boolean; boards: BoardRef[] }
export interface Person { address: string; owner: boolean }
export interface Board { id: string; server: {id: string; name: string; address: string}; name: string; plan: string; version: number; open: boolean; guests: boolean; people?: Person[] }
/** A post as the Remote gives it: `by` is all a reader is shown of who wrote it. */
export interface Post { id: string; by: string; body: string; at: number; guest?: boolean; mine?: boolean; mayTakeDown?: boolean }
export interface OpenBoard { id: string; name: string; server: string; guests: boolean }
interface Read { posts: Post[]; more: boolean }

/** The most a post says, as the Remote holds it to. */
export const LIMIT = 2000;

const failed = async (r: Response) => {
  const body = await r.json().catch(() => ({})) as {error?: string};
  const why: Record<string, string> = {'claim an address first': t('Claim an address first'), 'too many posts this hour': t('Too many posts this hour'),
    'only your contacts can be added': t('Only your contacts can be added'), 'a code was just sent': t('A code was just sent'), 'not that code': t('Not that code'),
    'this Remote sends no mail': t('This Remote sends no mail'), 'taken': t('That name is taken'), 'held': t('That name was let go, and is held for its owner a while'),
    'an address for it: letters, digits, - . _': t('Its address: letters, digits, - . _'), 'a domain you hold an address on': t('Only on a domain you hold an address on'),
    'only servers you are in': t('Only servers you are in'), 'which servers': t('Choose a server'), 'no repo': t('That repo is not on the Remote')};
  return new RemoteError(r.status, why[body.error ?? ''] ?? String(body.error ?? r.status));
};
const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const r = await api(path, init);
  if (!r.ok) throw await failed(r);
  return r.status === 204 ? undefined as T : r.json() as Promise<T>;
};
const send = (method: string, body?: unknown): RequestInit => ({method, ...(body === undefined ? {} : {body: JSON.stringify(body)})});

// ---- servers and their people ----
export const servers = () => (connection() ? call<Server[]>('/v1/servers') : Promise.resolve([]));
export const makeServer = (name: string, address: string) => call<Server>('/v1/servers', send('POST', {name, address}));
/** Servers this person removed or left last, still held for them, and until when. */
export const goneServers = () => call<{id: string; name: string; address: string; until: number}[]>('/v1/servers?gone=1');
export const bringBack = (id: string) => call<{id: string; name: string; address: string}>(`/v1/servers/${id}/back`, send('POST'));
/** Its owner's: held a while, to bring back. */
export const removeServer = (id: string) => call<{until: number}>(`/v1/servers/${id}`, send('DELETE'));
export const renameServer = (id: string, name: string) => call<{name: string}>(`/v1/servers/${id}`, send('PATCH', {name}));
export const people = (id: string) => call<Person[]>(`/v1/servers/${id}/people`);
export const addPerson = (id: string, address: string) => call<Person[]>(`/v1/servers/${id}/people`, send('POST', {address}));
export const removePerson = (id: string, address: string) => call<void>(`/v1/servers/${id}/people/${encodeURIComponent(address)}`, send('DELETE'));

// ---- boards ----
export const makeBoard = (server: string, name: string) => call<BoardRef>(`/v1/servers/${server}/boards`, send('POST', {name}));
/** Open boards, for anyone. */
export const openBoards = () => json<OpenBoard[]>('/v1/open');
/** A board: as one of its people, or as anyone if it is open. */
export const board = (id: string, member: boolean) => call<Board>(member ? `/v1/boards/${id}` : `/v1/open/${id}`);
export const setBoard = (id: string, change: {name?: string; open?: boolean; guests?: boolean}) => call<Board>(`/v1/boards/${id}`, send('PATCH', change));

export type Saved = {ok: true; plan: string; version: number; merged: boolean} | {ok: false; plan: string; version: number};
/** Send what changed in the plan, against the version it was made on; the Remote merges it with what came meanwhile, or says it could not. */
export async function savePlan(id: string, base: number, was: string, now: string): Promise<Saved> {
  const r = await api(`/v1/boards/${id}/plan`, send('PUT', {base, hunks: hunks(lines(was), lines(now))}));
  if (r.status === 409) { const b = await r.json() as {plan: string; version: number}; return {ok: false, plan: b.plan, version: b.version}; }
  if (!r.ok) throw await failed(r);
  return {ok: true, ...await r.json() as {plan: string; version: number; merged: boolean}};
}

// ---- the talk ----
const posts = (id: string, member: boolean) => (member ? `/v1/boards/${id}/posts` : `/v1/open/${id}/posts`);
/** The newest, or those older than `before`. */
export const older = (id: string, member: boolean, before: string | null, limit = 30) => call<Read>(`${posts(id, member)}?limit=${limit}${before ? `&before=${before}` : ''}`);
/** Those newer than `after`, oldest first (keep asking while `more`). */
export const newer = (id: string, member: boolean, after: string, limit = 30) => call<Read>(`${posts(id, member)}?limit=${limit}&after=${after}`);
/** A page again, by its range. */
export const range = (id: string, member: boolean, oldest: string, newest: string) => call<Read>(`${posts(id, member)}?limit=100&from=${oldest}&to=${newest}`);
export const post = (id: string, body: string) => call<Post>(`/v1/boards/${id}/posts`, send('POST', {body}));
export const takeDown = (id: string, post: string) => call<void>(`/v1/boards/${id}/posts/${post}`, send('DELETE'));

// ---- repos: who sees each (service/seen.ts) ----
/** Only its owner, the servers it is shown in, or everyone. */
export type Seen = 'private' | 'servers' | 'everyone';
/** Who sees one of mine: and, seen by everyone, the name it is seen as (`as`), a server's or my own. */
export interface RepoSeen { name: string; seen: Seen; servers: {id: string; name: string; address: string}[]; as: string | null; asServer: string | null }
/** A repo shown in a server: whose, and the name everyone sees it as, if they do. */
export interface ShownRepo { owner: string; name: string; at: number | null; mine: boolean; as: string | null; asServer: string | null }
/** A repo as seen by someone not its owner: what it was last pushed to. `owner` only where whose it is may be told. */
export interface SeenRepo { as: string; owner?: string; title: string | null; at: number | null; tree: Record<string, string | null> }

export const seenAll = () => call<RepoSeen[]>('/v1/seen');
/** `as`: a server's id, or 'me' (by default the first server it is shown in, else me). */
export const setSeen = (repo: string, seen: Seen, more: {servers?: string[]; as?: string} = {}) =>
  call<RepoSeen>(`/v1/repos/${encodeURIComponent(repo)}/seen`, send('PUT', {seen, ...more}));
export const shownIn = (server: string) => call<ShownRepo[]>(`/v1/servers/${server}/repos`);
export const showIn = (server: string, repo: string) => call<ShownRepo[]>(`/v1/servers/${server}/repos`, send('POST', {repo}));
export const takeOff = (server: string, owner: string, repo: string) => call<void>(`/v1/servers/${server}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, send('DELETE'));
const seenPath = (as: string) => { const [face, name] = as.split(':'); return `/v1/seen/${encodeURIComponent(face)}/${encodeURIComponent(name)}`; };
/** `face:name`: what it was last pushed to. */
export const seeRepo = (as: string) => call<SeenRepo>(seenPath(as));
/** A file of it, as text. */
export async function seeFile(as: string, sha: string): Promise<string> {
  const r = await api(`${seenPath(as)}/blobs/${sha}`);
  if (!r.ok) throw await failed(r);
  return new TextDecoder().decode(await r.arrayBuffer());
}

/** The board taken home as text: its plan, its talk, or both. */
export async function archive(id: string, member: boolean, what: {plan?: boolean; talk?: boolean} = {}): Promise<string> {
  const r = await api(`${member ? `/v1/boards/${id}` : `/v1/open/${id}`}/archive?plan=${what.plan === false ? 0 : 1}&talk=${what.talk === false ? 0 : 1}`);
  if (!r.ok) throw await failed(r);
  return r.text();
}

// ---- guests: an outsider writes once an email is shown to be theirs ----
const GUEST = 'length3.guest.';
/** This browser's guest token for a board, if it has one (a convenience: it may be forgotten). */
export function guestOf(id: string): {token: string; as: string} | null {
  try { const v = localStorage.getItem(GUEST + id); return v ? JSON.parse(v) as {token: string; as: string} : null; } catch { return null; }
}
export const guestCode = (id: string, email: string) => call<{sent: boolean}>(`/v1/open/${id}/guest`, send('POST', {email}));
export async function guestCheck(id: string, email: string, code: string) {
  const g = await call<{token: string; as: string}>(`/v1/open/${id}/guest/check`, send('POST', {email, code}));
  try { localStorage.setItem(GUEST + id, JSON.stringify(g)); } catch { /* asked again next time */ }
  return g;
}
export const guestPost = (id: string, token: string, body: string) => call<Post>(`/v1/open/${id}/posts`, {...send('POST', {body}), headers: {'X-Guest': token}});

/** A page of the timeline: the range of ids it was read as, and its posts while they are held. */
export interface Page { newest: string; oldest: string; posts: Post[] | null }

export const pageOf = (posts: Post[]): Page | null =>
  posts.length ? {newest: posts[0].id, oldest: posts[posts.length - 1].id, posts} : null;

/** What came after, as the Remote gives it (oldest first), as pages to put on top, newest page first. */
export function onTop(came: Post[], size = 30): Page[] {
  const pages: Page[] = [];
  for (let i = 0; i < came.length; i += size) pages.unshift(pageOf(came.slice(i, i + size).reverse())!);
  return pages;
}

/**
 * Which pages may let go of their posts: those further than `keep` pages from
 * every page in view (`near`, by index). Their range stays, to read them again.
 */
export function farFrom(count: number, near: readonly number[], keep: number): number[] {
  if (!near.length) return [];
  const lo = Math.min(...near) - keep, hi = Math.max(...near) + keep;
  const out: number[] = [];
  for (let i = 0; i < count; i++) if (i < lo || i > hi) out.push(i);
  return out;
}

/** Posts by one address this close together read as one run: one face and name for them all. */
export const RUN_MS = 5 * 60_000;
/** Whether `b` (just after `a` in time) goes on in `a`'s run. */
export const sameRun = (a: Post | undefined, b: Post) => a !== undefined && a.by === b.by && b.at - a.at >= 0 && b.at - a.at < RUN_MS;
/** The local day of `ms`, as a key. */
export const dayOf = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
