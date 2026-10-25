// A look at the Remote taken every little while (what moved, what came, a conversation's rows, a board's posts
// and TODO), asked with the tag its last answer carried (service/mark.ts): while nothing was written on the Remote
// since, it answers 304 without asking its database (which then sleeps), and the answer kept here stands. Each
// path's last answer is kept for this device's session only. The window coming back (focus, shown again) asks
// every look afresh, without tags, so what changed where no request of the Remote's saw it is read then.

import {api, connection, onWrite} from './remote.ts';

/** Each path's last answer (its words, so each read is a copy of its own) and its tag, under the token it was asked with. */
const kept = new Map<string, {token: string; tag: string; text: string; type: string}>();
/** Paths kept at most (a board's posts are asked from where they were read up to: a path each time something came). */
const MOST = 64;

/**
 * GET `path` as api() asks it, with the tag of the answer kept for it: the Remote's answer, or, when it says nothing
 * changed since (304), the one kept here, as a 200 of its own. Read as any answer of api()'s is.
 */
export async function lookAt(path: string): Promise<Response> {
  const c = connection();
  const had = kept.get(path);
  const tag = had && c && had.token === c.token ? had.tag : null;
  const r = await api(path, {cache: 'no-store', ...(tag ? {headers: {'If-None-Match': tag}} : {})});
  if (r.status === 304 && had && tag) return new Response(had.text, {status: 200, headers: {'Content-Type': had.type}});
  kept.delete(path);
  const now = r.headers.get('ETag');
  if (!now || !c || r.status !== 200) return r;
  const text = await r.text();
  const type = r.headers.get('Content-Type') ?? 'application/json';
  kept.set(path, {token: c.token, tag: now, text, type});
  if (kept.size > MOST) kept.delete(kept.keys().next().value!);
  return new Response(text, {status: 200, headers: {'Content-Type': type}});
}

/** Every look's next ask is afresh: what the Remote says then is read whatever its mark says. */
export const afresh = () => kept.clear();
// This page's own write: the Remote moves its mark only once it has answered, so a look right after it could be told
// nothing changed and show what was there before it.
onWrite(afresh);

// Before the listeners that look (capture: at the window or document itself, those run first), so a look the
// window's coming back sets off goes without its tag.
if (typeof addEventListener === 'function' && typeof document !== 'undefined') {
  addEventListener('focus', afresh, {capture: true});
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') afresh(); }, {capture: true});
}
