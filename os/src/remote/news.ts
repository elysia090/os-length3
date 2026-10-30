// What came in that has not been seen (service/news.ts): messages not read
// in the Inbox, and the boards with posts by others past what was on screen.
// The rail marks Inbox and Server by it (main.ts); Server marks its chips and
// boards. Looked for every little while, when the window comes back, and at
// once when something here was just seen.

import {api, connection, mayAsk, reading} from './connection.ts';
import {lookAt} from './looks.ts';
import {every} from '../app/runs.ts';

/** As the Remote says it: each board with the newest post on it by someone else. */
export interface News { inbox: number; boards: {id: string; server: string; post: string}[] }

export const NONE: News = {inbox: 0, boards: []};
/** How often it is looked for while the window is in view. */
const EVERY = 20_000;

// ---- what it means, as plain functions ----

/** Which of the rail's places have something new. */
export const marks = (n: News) => ({inbox: n.inbox > 0, server: n.boards.length > 0});
/** Whether a board, or any board of a server, has something new. */
export const isNewBoard = (n: News, id: string) => n.boards.some((b) => b.id === id);
export const isNewServer = (n: News, id: string) => n.boards.some((b) => b.server === id);
/** A board seen here: not new, at once. */
export const forget = (n: News, board: string): News => (isNewBoard(n, board) ? {...n, boards: n.boards.filter((b) => b.id !== board)} : n);
/**
 * What the Remote said, less the boards this device has had on screen up to their newest
 * (`told`, by board): a look that crossed the telling does not bring a board back.
 */
export const notTold = (n: News, told: ReadonlyMap<string, string>): News =>
  ({...n, boards: n.boards.filter((b) => (told.get(b.id) ?? '') < b.post)});
/** Whether reading a board up to `post` is worth telling, past what was told (ids sort as their time). */
export const furtherThan = (told: ReadonlyMap<string, string>, board: string, post: string) => (told.get(board) ?? '') < post;

// ---- as this app hears it ----

let now: News = NONE;
const hearers = new Set<(n: News) => void>();
const hear = (n: News) => {
  const changed = JSON.stringify(n) !== JSON.stringify(now);
  now = n;
  if (changed) for (const f of [...hearers]) f(now);
};
/** Each board's newest post this device has had on screen and told the Remote of. */
const told = new Map<string, string>();

/** What is new now, as last heard. */
export const news = (): News => now;
/** Hear it change; the returned function stops hearing. */
export function onNews(f: (n: News) => void): () => void { hearers.add(f); return () => hearers.delete(f); }
export const boardNew = (id: string) => isNewBoard(now, id);
export const serverNew = (id: string) => isNewServer(now, id);

let asking: Promise<void> | null = null;
/** Ask the Remote now. Signed out there is nothing; not answered, what was last heard stays. */
export function look(): Promise<void> {
  if (!connection()) { hear(NONE); return Promise.resolve(); }
  // With its last answer's tag: nothing written on the Remote since, it is answered without its database.
  asking ??= lookAt('/v1/news').then((r) => reading<News>(r)).then((n) => {
    if (n && typeof n.inbox === 'number' && Array.isArray(n.boards)) hear(notTold(n, told));
  }, () => {}).finally(() => { asking = null; });
  return asking;
}

/** A board's talk was on screen up to `post`: it is not new here at once, and the Remote is told. */
export function sawBoard(board: string, post: string): Promise<void> {
  hear(forget(now, board));
  if (!connection() || !furtherThan(told, board, post)) return Promise.resolve();
  const was = told.get(board);
  told.set(board, post);
  // Not told (the Remote away): taken back, so the next time it is on screen tells it again; the mark here is gone either way.
  return api(`/v1/boards/${encodeURIComponent(board)}/seen`, {method: 'POST', body: JSON.stringify({post})}).then(() => {}, () => {
    if (told.get(board) !== post) return;
    if (was === undefined) told.delete(board); else told.set(board, was);
  });
}

let looking: {stop(): void} | null = null;
/** Start looking: now, every little while in view (slower while nobody is at it: runs.ts paced), and when someone comes back. */
export function begin() {
  looking?.stop();
  void look();
  looking = every(EVERY, () => (mayAsk() ? look() : undefined), {paced: true});
  // The window taken up again: asked at once (one request, when someone is there to see it), not at the next look.
  if (!focused) { focused = true; window.addEventListener('focus', () => { if (mayAsk()) void look(); }); }
}
let focused = false;
