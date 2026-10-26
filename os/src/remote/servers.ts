// Servers on the Remote (service/servers.ts): groups of people who know
// each other, whose boards are each a conversation and a TODO kept together
// (Home's list, src/home/todo.ts). The one thing whose subject is people, not a
// repo.
//
// A board's talk is pages, each the range of ids it was read as (its newest
// and oldest). A page's posts can be let go of and read again by that range
// (the same posts, less any taken down), so what a reader holds stays about
// what is near the screen however far they scroll.

import {api, connection, json, onWrite, reading, RemoteError, retryAfter} from './connection.ts';
import {lookAt} from './looks.ts';
import type {Todo} from '../home/todo.ts';
import {t} from '../i18n.ts';
import {errorText} from '../app/errors.ts';

/** `gone`: removed, and held until then (ms); its server's owner may bring it back meanwhile. */
export interface BoardRef { id: string; name: string; open: boolean; guests: boolean; gone?: number }
/** A server: what it is called, and its name as a principal (name@domain, in the namespace people's addresses are in). */
/** `made`: the one asking made it (the Remote holds what its maker leaves alone a day, not HOLD). */
export interface Server { id: string; name: string; address: string; owner: boolean; boards: BoardRef[]; code: string; until: number | null; made?: boolean }
/** `id` names one with no name left (released or let go), whom the owner still removes by it. */
export interface Person { address: string; owner: boolean; id?: string }
export interface Board { id: string; server: {id: string; name: string; address: string}; name: string; open: boolean; guests: boolean; people?: Person[] }
/** A post as the Remote gives it: `by` is all a reader is shown of who wrote it. */
export interface Post { id: string; by: string; body: string; at: number; guest?: boolean; mine?: boolean; mayTakeDown?: boolean }
export interface OpenBoard { id: string; name: string; server: string; guests: boolean }
interface Read { posts: Post[]; more: boolean }

/** The most a post says, as the Remote holds it to. */
export const LIMIT = 2000;

/**
 * What the Remote said no to: its sentence, in the person's language, and what it said with it (its own words among
 * them), for the place that asked to tell one no from another (making a server: a name to claim first, a name taken).
 */
const failed = async (r: Response) => {
  const body = await r.json().catch(() => ({})) as {error?: string};
  return new RemoteError(r.status, t(String(body.error ?? r.status)), body as Record<string, unknown>);
};
const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const r = await api(path, init);
  if (!r.ok) throw await failed(r);
  return r.status === 204 ? undefined as T : reading<T>(r);
};
/** A GET looked at every little while, asked with its last answer's tag (looks.ts), read as `call` reads it. */
const looked = async <T>(path: string): Promise<T> => {
  const r = await lookAt(path);
  if (!r.ok) throw await failed(r);
  return reading<T>(r);
};
const send = (method: string, body?: unknown): RequestInit => ({method, ...(body === undefined ? {} : {body: JSON.stringify(body)})});

// ---- servers and their people ----
/**
 * The list as last asked, for what asks again within a moment: a page drawn twice as the OS opens (and Home's two
 * parts that each name the servers) is drawn from one answer, not four requests. Anything this page writes on the
 * Remote asks afresh (an invitation accepted in Inbox is a server joined).
 */
let listed: {at: number; token: string; list: Promise<Server[]>} | null = null;
onWrite(() => { listed = null; });
const SHARED_FOR = 2000;
export const servers = (): Promise<Server[]> => {
  const c = connection();
  if (!c) return Promise.resolve([]);
  if (!listed || listed.token !== c.token || Date.now() - listed.at > SHARED_FOR) {
    const list = call<Server[]>('/v1/servers');
    const kept = listed = {at: Date.now(), token: c.token, list};
    list.catch(() => { if (listed === kept) listed = null; });
  }
  // Each its own copy: what one caller does with its list is not another's.
  return listed.list.then((l) => structuredClone(l));
};
export const makeServer = (name: string, address: string) => call<Server>('/v1/servers', send('POST', {name, address}));
/** Servers this person removed or left last, still held for them, and until when. */
export const goneServers = () => call<{id: string; name: string; address: string; until: number}[]>('/v1/servers?gone=1');
export const bringBack = (id: string) => call<{id: string; name: string; address: string}>(`/v1/servers/${id}/back`, send('POST'));
/** Its name held for another term, by its owner. */
export const renewServer = (id: string) => call<{address: string; until: number}>(`/v1/servers/${id}/renew`, send('POST'));
/** Its owner's: held a while, to bring back. */
export const removeServer = (id: string) => call<{until: number}>(`/v1/servers/${id}`, send('DELETE'));
/** How long the Remote holds a server removed or left last (service/names.ts HOLD), and one its maker leaves alone in it (SERVER.alone). */
export const HELD = 30 * 86_400_000, HELD_ALONE = 86_400_000;

/**
 * What leaving `s` and removing it come to, as the Remote does them (service/servers.ts, gone and the leave):
 * `people` as the Remote lists them (by when they came in), `mine` the asker's address among them. Left by the
 * last in it, it goes; left by its owner with others in it, the first of them to have come in owns it.
 * Removed, or left last, it is held HELD, or HELD_ALONE when its maker is alone in it.
 */
export function ending(s: Pick<Server, 'owner' | 'made'>, people: Person[], mine: string | null): {remove: number; leave: number; last: boolean; heir: string | null} {
  const others = people.filter((p) => p.address !== mine);
  const held = s.made && !others.length ? HELD_ALONE : HELD;
  return {remove: held, leave: held, last: !others.length, heir: s.owner && others.length ? others[0].address : null};
}
export const people = (id: string) => call<Person[]>(`/v1/servers/${id}/people`);
export const addPerson = (id: string, address: string) => call<Person[]>(`/v1/servers/${id}/people`, send('POST', {address}));
export const removePerson = (id: string, address: string) => call<void>(`/v1/servers/${id}/people/${encodeURIComponent(address)}`, send('DELETE'));

/** How adding someone by a name or a code reaches the Remote (the Inbox's lookup and send, Server's adding); a test gives its own. */
export interface AddWays {
  lookup(typed: string): Promise<{address?: string; reachable: boolean; why?: string}>;
  add(server: string, address: string): Promise<unknown>;
  ask(address: string, body: string, server: string): Promise<{request: boolean}>;
  /** In at once: they are told so in their Inbox, by a message about the server (a way to it there). */
  tell(address: string, body: string, server: string): Promise<unknown>;
}
/** How adding someone came out: in now, already in, or asked in the Inbox and in once they accept. */
export type Added = {address: string; is: 'in' | 'already' | 'asked'};

/**
 * Someone added to a server by their name or code, though they are not one's contact yet. In
 * at once when the two have accepted each other. Otherwise they are asked in the Inbox, by a
 * message about the server, a request until they accept; they are in once they accept (the
 * Remote does it, service/inbox.ts), or at once if they had accepted one already.
 */
export async function addByName(s: Pick<Server, 'id' | 'name'>, typed: string, people: readonly string[], ways: AddWays): Promise<Added> {
  const found = await ways.lookup(typed.trim());
  if (!found.reachable || !found.address) throw new RemoteError(404, t(found.why ?? 'No one has that address'));
  const address = found.address;
  if (people.includes(address)) return {address, is: 'already'};
  const tryAdd = () => ways.add(s.id, address).then(() => true, (e: unknown) => { if (e instanceof RemoteError && e.status === 403) return false; throw e; });
  // In at once, they are told, as someone asked is: nothing came to them otherwise. Not told (the Inbox away), they
  // are in all the same.
  if (await tryAdd()) { await told(ways, address, s); return {address, is: 'in'}; }
  const r = await ways.ask(address, t('I would like to add you to {server}. Accept me in your Inbox and you are in it.', {server: s.name}), s.id);
  // They had accepted one: writing to them accepted them back, so the two know each other now.
  if (!r.request && await tryAdd()) return {address, is: 'in'};
  return {address, is: 'asked'};
}

/** Someone added at once, told so in their Inbox; not told (the Inbox away), they are in all the same. */
export const told = (ways: Pick<AddWays, 'tell'>, address: string, s: Pick<Server, 'id' | 'name'>) =>
  ways.tell(address, t('I added you to {server}.', {server: s.name}), s.id).catch(() => {});

// ---- boards ----
export const makeBoard = (server: string, name: string) => call<BoardRef>(`/v1/servers/${server}/boards`, send('POST', {name}));
/** Its server's owner's: it goes with its talk and TODO, held 30 days (until) to bring back. */
export const removeBoard = (id: string) => call<{until: number}>(`/v1/boards/${id}`, send('DELETE'));
export const bringBackBoard = (id: string) => call<Board>(`/v1/boards/${id}/back`, send('POST'));
/** Open boards, for anyone. */
export const openBoards = () => json<OpenBoard[]>('/v1/open');
/** A board: as one of its people, or as anyone if it is open. */
export const board = (id: string, member: boolean) => call<Board>(member ? `/v1/boards/${id}` : `/v1/open/${id}`);
export const setBoard = (id: string, change: {name?: string; open?: boolean; guests?: boolean}) => call<Board>(`/v1/boards/${id}`, send('PATCH', change));

// ---- a board's TODO: Home's list, kept on the Remote item by item ----
/** An item as a board keeps it: Home's, with its place in the list and who wrote it first. */
export interface BoardTodo extends Todo { place: number; by: string }
export const todos = (id: string, member: boolean) => (member ? looked<BoardTodo[]>(`/v1/boards/${id}/todos`) : call<BoardTodo[]>(`/v1/open/${id}/todos`));
const putTodo = (board: string, id: string, change: Partial<BoardTodo>) => call<BoardTodo>(`/v1/boards/${board}/todos/${encodeURIComponent(id)}`, send('PUT', change));
const dropTodo = (board: string, id: string) => call<void>(`/v1/boards/${board}/todos/${encodeURIComponent(id)}`, send('DELETE'));

/** How a board's TODO reaches the Remote, item by item; a test gives its own. */
export interface TodoWays {
  put(board: string, id: string, change: Partial<BoardTodo>): Promise<BoardTodo>;
  drop(board: string, id: string): Promise<void>;
}
const remoteTodos: TodoWays = {put: putTodo, drop: dropTodo};

export interface KeeperOptions {
  ways?: TodoWays;
  /** Why what was written is not on the Remote yet; it is sent again by itself. */
  trouble?: (why: string) => void;
  /** The pause in writing before it is sent. */
  pause?: number;
  /** The wait before the n-th try again (n from 1). */
  backoff?: (n: number) => number;
}

/** A failure another try may get past: the Remote away, too busy, or failing for a moment. */
const passing = (e: unknown) => e instanceof RemoteError && (e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500);

/**
 * A board's TODO as the TODO box keeps it: after a pause in writing, each
 * item sends only what changed of it, so others' changes to its other fields
 * stay (a new one sends all of it, at a place between its neighbours'), and
 * each one taken out is taken off.
 *
 * What could not be sent for a passing reason (the Remote away) is sent again
 * by itself, later each time, and until it is, the keeper is not idle, so
 * the board's next look does not put the Remote's list over it. A save's
 * promise settles once what it held is on the Remote, or is refused for good.
 */
export function todoKeeper(board: string, from: readonly BoardTodo[], o: KeeperOptions = {}) {
  const {ways = remoteTodos, trouble, pause = 600, backoff = (n) => Math.min(30_000, 1000 * 2 ** (n - 1))} = o;
  const had = new Map<string, BoardTodo>(from.map((x) => [x.id, x]));
  let latest: Todo[] | null = null, wait: ReturnType<typeof setTimeout> | undefined, busy = false, tries = 0;
  /** Those waiting on a save: answered when nothing written is left to send. */
  let waiting: {resolve(): void; reject(e: unknown): void}[] = [];
  const placeAt = (list: readonly Todo[], i: number) => {
    const before = i > 0 ? had.get(list[i - 1].id)?.place : undefined;
    const after = list.slice(i + 1).map((x) => had.get(x.id)?.place).find((p) => p !== undefined);
    return before === undefined ? (after === undefined ? i : after - 1) : after === undefined ? before + 1 : (before + after) / 2;
  };
  /** Send `list`: what changed of each item since the Remote last had it, then what was taken out. Sent again, only what is still to send goes. */
  const send = async (list: readonly Todo[]) => {
    for (const [i, x] of list.entries()) {
      const was = had.get(x.id);
      const change: Partial<BoardTodo> = was ? {} : {place: placeAt(list, i), created: x.created};
      for (const k of ['kind', 'title', 'detail', 'done'] as const) if (!was || x[k] !== was[k]) (change as Record<string, unknown>)[k] = x[k];
      if (!Object.keys(change).length) continue;
      // Taken off by someone else meanwhile: it stays off (the next look shows it gone), not brought back.
      const got = await ways.put(board, x.id, change).catch((e: unknown) => { if (was && e instanceof RemoteError && e.status === 404) return null; throw e; });
      if (got) had.set(x.id, got); else had.delete(x.id);
    }
    for (const id of [...had.keys()]) {
      if (list.some((x) => x.id === id)) continue;
      // Already gone (taken off elsewhere, or by a try whose answer was lost): what was wanted.
      await ways.drop(board, id).catch((e: unknown) => { if (!(e instanceof RemoteError && e.status === 404)) throw e; });
      had.delete(id);
    }
  };
  const answer = (e?: unknown) => {
    const w = waiting;
    waiting = [];
    for (const x of w) if (e === undefined) x.resolve(); else x.reject(e);
  };
  const go = async () => {
    wait = undefined;
    busy = true;
    try {
      while (latest) {
        const list = latest;
        latest = null;
        try { await send(list); } catch (e) {
          // What failed is sent again, unless something newer is waiting to go in its place.
          latest ??= list;
          if (!passing(e)) { latest = null; tries = 0; answer(e); return; }
          tries++;
          trouble?.(errorText(e));
          // Not sooner than the Remote said (asked too often: its Retry-After).
          wait = setTimeout(() => void go(), Math.max(retryAfter(e) ?? 0, backoff(tries)));
          return;
        }
      }
      tries = 0;
      answer();
    } finally { busy = false; }
  };
  return {
    save(kept: Todo[]): Promise<void> {
      latest = kept;
      // While a try again waits, writing on sends sooner: after the pause, as any change.
      clearTimeout(wait);
      const done = new Promise<void>((resolve, reject) => { waiting.push({resolve, reject}); });
      if (busy) wait = undefined; else wait = setTimeout(() => void go(), pause);
      return done;
    },
    /** Nothing written here is waiting to be sent. */
    idle: () => !latest && wait === undefined && !busy,
    /** The list as the Remote has it now. */
    took(list: readonly BoardTodo[]) { had.clear(); for (const x of list) had.set(x.id, x); },
  };
}

// ---- the talk ----
const posts = (id: string, member: boolean) => (member ? `/v1/boards/${id}/posts` : `/v1/open/${id}/posts`);
/** The newest, or those older than `before`. */
export const older = (id: string, member: boolean, before: string | null, limit = 30) => call<Read>(`${posts(id, member)}?limit=${limit}${before ? `&before=${before}` : ''}`);
/** Those newer than `after`, oldest first (keep asking while `more`). */
export const newer = (id: string, member: boolean, after: string, limit = 30) => (member ? looked<Read> : call<Read>)(`${posts(id, member)}?limit=${limit}&after=${after}`);
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
export interface ShownRepo { owner: string; ownerId?: string; name: string; at: number | null; mine: boolean; as: string | null; asServer: string | null }
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
/** A file of it, by its path, as text. */
export async function seeFile(as: string, path: string): Promise<string> {
  const r = await api(`${seenPath(as)}/file?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw await failed(r);
  return new TextDecoder().decode(await r.arrayBuffer());
}

/** The board taken home as text: its TODO, its talk, or both. */
export async function archive(id: string, member: boolean, what: {todo?: boolean; talk?: boolean} = {}): Promise<string> {
  const r = await api(`${member ? `/v1/boards/${id}` : `/v1/open/${id}`}/archive?todo=${what.todo === false ? 0 : 1}&talk=${what.talk === false ? 0 : 1}`);
  if (!r.ok) throw await failed(r);
  return r.text();
}

// ---- guests: an outsider writes once one of a board's people has invited them ----
//
// One of its people makes an invitation and passes its link on themselves (…/#guest=BOARD.INVITE);
// the Remote sends nothing. Whoever opens it chooses a name, always shown as a guest's, and this
// browser keeps the token it is given for that board.

/** An invitation as one of its people sees it; a guest let in. */
export interface Invitation { id: string; by: string; uses: number; until: number; mine: boolean; mayRevoke: boolean }
export interface Guest { id: string; name: string; by: string; until: number; mayRemove: boolean }
/** What this browser holds as a guest of a board: its token, the name it writes as, and the board's names. */
export interface GuestHere { token: string; as: string; name: string; server: string }

const GUEST = 'length3.guest.';
const INVITED = 'length3.invited';
/** This browser's guest token for a board, if it has one (a convenience: it may be forgotten). */
export function guestOf(id: string): GuestHere | null {
  try { const v = localStorage.getItem(GUEST + id); return v ? JSON.parse(v) as GuestHere : null; } catch { return null; }
}
/** The boards this browser is a guest of, by id. */
export function guestBoards(): {id: string; here: GuestHere}[] {
  const out: {id: string; here: GuestHere}[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const here = k?.startsWith(GUEST) ? guestOf(k.slice(GUEST.length)) : null;
      if (k && here?.token) out.push({id: k.slice(GUEST.length), here});
    }
  } catch { /* none kept */ }
  return out;
}
/** No longer a guest of that board here (removed, or the lease ran out). */
export function forgetGuest(id: string) {
  try { localStorage.removeItem(GUEST + id); } catch { /* nothing kept */ }
}

/** An invitation's link, as the app was opened by it: held for this tab until it is used. */
export function holdInvite(board: string, code: string) {
  try { sessionStorage.setItem(INVITED, JSON.stringify({board, code})); } catch { /* used now or not at all */ }
}
export function heldInvite(): {board: string; code: string} | null {
  try { return JSON.parse(sessionStorage.getItem(INVITED) ?? 'null') as {board: string; code: string} | null; } catch { return null; }
}
export function dropInvite() {
  try { sessionStorage.removeItem(INVITED); } catch { /* nothing held */ }
}
/** Read from an address's fragment (…#guest=BOARD.INVITE), if it is one. */
export const inviteIn = (hash: string): {board: string; code: string} | null => {
  const m = /(?:^#|&)guest=([0-9a-z]{12})\.([0-9a-f]{32})(?:&|$)/.exec(hash);
  return m ? {board: m[1], code: m[2]} : null;
};

/** In as a guest, by the invitation held: the token is kept here for that board, and the invitation is spent. */
export async function guestJoin(board: {id: string; name: string; server: string}, code: string, as: string): Promise<GuestHere> {
  const g = await call<{token: string; as: string}>(`/v1/open/${board.id}/guest`, send('POST', {invite: code, name: as}));
  const here = {token: g.token, as: g.as, name: board.name, server: board.server};
  try { localStorage.setItem(GUEST + board.id, JSON.stringify(here)); } catch { /* asked again next time */ }
  dropInvite();
  return here;
}
/** Still a guest here? 403 says not (removed, or the lease ran out). */
export const guestStill = (id: string, token: string) => call<{id: string; as: string}>(`/v1/open/${id}/guest`, {headers: {'X-Guest': token}});
export const guestPost = (id: string, token: string, body: string) => call<Post>(`/v1/open/${id}/posts`, {...send('POST', {body}), headers: {'X-Guest': token}});
/** An open board by its id (what an invitation's link names). */
export const openBoard = (id: string) => call<Board>(`/v1/open/${id}`);

// Its people's side: invitations out and guests in.
export const guestsOf = (board: string) => call<{invites: Invitation[]; guests: Guest[]}>(`/v1/boards/${board}/guests`);
export const invite = (board: string, o: {uses?: number; days?: number} = {}) =>
  call<{id: string; invite: string; link: string; uses: number; until: number}>(`/v1/boards/${board}/invites`, send('POST', o));
export const revokeInvite = (board: string, id: string) => call<void>(`/v1/boards/${board}/invites/${id}`, send('DELETE'));
export const removeGuest = (board: string, id: string) => call<void>(`/v1/boards/${board}/guests/${id}`, send('DELETE'));

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
export const sameRun = (a: Post | undefined, b: Post) => a !== undefined && a.by === b.by && !a.guest === !b.guest && b.at - a.at >= 0 && b.at - a.at < RUN_MS;
/** The local day of `ms`, as a key. */
export const dayOf = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
