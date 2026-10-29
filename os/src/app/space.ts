// この端末: everything this OS holds here, largest first, and what can be
// done with each (core/src/usage.rs in the app). In a browser what it holds
// is its copy of the repos, and what l3 keeps of itself for the Prompt (kept:
// the Prompt runs on it, so it is said apart and never freed); each repo the Remote has all of can go now, one
// with changes not sent yet goes once they are sent, and without a Remote
// nothing goes. A repo that goes stays on the Remote and comes back when
// it is opened.

import {core, isNative, readCapacity, type Freed, type Item, type Space} from './host.ts';
import {flush, look} from '../remote/lifecycle.ts';
import {store} from '../repos/repos.ts';
import {t, tn} from '../i18n.ts';
import {keptL3} from '../prompt/userland.ts';

/** `open`: repos a Prompt has open in this page (the app knows its own). */
export async function readSpace(open: string[] = []): Promise<Space> {
  const s = await core<Space>('space');
  if (isNative) return s;
  // In a browser the core holds the repos; the host is the origin's storage, as the browser estimates it. A repo the
  // core would let go is kept while a Prompt here has it open; one it keeps already says its own reason (no Remote
  // to free it to), not the Prompt.
  const items: Item[] = s.items.map((i) => (open.includes(i.what) && i.id.startsWith('repo:') && i.room !== 'Keep' ? {...i, room: 'Keep', why: t('A Prompt has it open')} : i));
  // What l3 keeps of itself for the Prompt (its index, the translator, the hot programs): the l3 every Prompt runs on,
  // so it is kept, not freed (issue #46), here and in Free all alike; the app keeps its own the same (core/src/usage.rs).
  const l3 = await keptL3();
  if (l3.files) items.push({id: 'l3', what: 'l3', detail: tn('{n} file kept for the Prompt', '{n} files kept for the Prompt', l3.files), allocated: l3.bytes,
    room: 'Keep', why: t('The Prompt runs on it, so it is kept')});
  items.sort((a, b) => b.allocated - a.allocated || a.what.localeCompare(b.what));
  const c = await readCapacity();
  return {
    host_total: c?.total ?? 0, host_free: c?.free ?? 0, host: 'Estimated',
    allocated: c?.app ?? items.reduce((n, i) => n + i.allocated, 0),
    freeable: items.filter((i) => i.room !== 'Keep').reduce((n, i) => n + i.allocated, 0), items,
  };
}

/**
 * 空ける a repo turned off on the Remote: nothing can be sent to it now, so
 * the copy here goes only when it holds nothing the Remote lacks.
 */
export async function freeOff(name: string): Promise<void> {
  const r = await core<Freed>('free', {ids: [`repo:${name}`]});
  if (r.kept.length) throw new Error(r.kept[0][1]);
  store.changedOutside(name, 'space');
  await look();
}

/** 空ける these; each repo is sent first and goes only once the Remote has all of it. */
export async function free(ids: string[]): Promise<Freed> {
  await flush();
  // l3 is never among them (readSpace keeps it); asked for all the same, it stays.
  const result = await core<Freed>('free', {ids: ids.filter((id) => id !== 'l3')});
  // Whatever went is no longer here for Forge, File and Home either.
  for (const id of result.removed) if (id.startsWith('repo:')) store.changedOutside(id.slice(5), 'space');
  await look();
  return result;
}
