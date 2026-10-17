// Topic: short posts on the Remote (service/topic.ts), one timeline for
// everyone there, newest first, read a page at a time by id.
//
// The timeline is pages, each the range of ids it was read as (its newest
// and oldest). A page's posts can be let go of and read again by that range
// (the same posts, less any taken down), so what a reader holds stays about
// what is near the screen however far they scroll.

import {api, json, RemoteError} from './remote.ts';
import {t} from './i18n.ts';

export interface Post { id: string; address: string; name: string; body: string; at: number; mine: boolean }
interface Read { posts: Post[]; more: boolean; total?: number }

/** The most a post says, as the Remote holds it to. */
export const LIMIT = 500;

/** The newest, or those older than `before`. */
export const older = (before: string | null, limit = 30) =>
  json<Read>(`/v1/topic?limit=${limit}${before ? `&before=${before}` : ''}`);
/** Those newer than `after`, oldest first (keep asking while `more`). */
export const newer = (after: string, limit = 30) => json<Read>(`/v1/topic?limit=${limit}&after=${after}`);
/** A page again, by its range. */
export const range = (oldest: string, newest: string) => json<Read>(`/v1/topic?limit=100&from=${oldest}&to=${newest}`);
/** One's own, newest first, and how many. */
export const mine = (limit = 5) => json<Read>(`/v1/topic?by=me&limit=${limit}`);

export async function post(body: string): Promise<Post> {
  const r = await api('/v1/topic', {method: 'POST', body: JSON.stringify({body})});
  const out = await r.json() as Post & {error?: string};
  if (r.ok) return out;
  const why: Record<string, string> = {'claim an address first': t('Claim an address first'), 'too many posts this hour': t('Too many posts this hour')};
  throw new RemoteError(r.status, why[out.error ?? ''] ?? String(out.error ?? r.status));
}

export const takeDown = (id: string) => api(`/v1/topic/${id}`, {method: 'DELETE'}).then((r) => {
  if (!r.ok && r.status !== 404) throw new RemoteError(r.status, String(r.status));
});

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
