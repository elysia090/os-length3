// この端末: everything this OS holds here, largest first, and what can be
// done with each (core/src/usage.rs in the app). In a browser what it holds
// is its copy of the repos; each one the Remote has all of can go now, one
// with changes not sent yet goes once they are sent, and without a Remote
// nothing goes. A repo that goes stays on the Remote and comes back when
// it is opened.

import * as draft from './draft.ts';
import {isNative, nativeFree, nativeSpace, readCapacity, type Freed, type Item, type Space} from './host.ts';
import {flush, look, repoState} from './lifecycle.ts';
import {connection} from './remote.ts';
import {kept, store} from './repos.ts';
import {t, tn} from './i18n.ts';

/** `open`: repos a Prompt has open in this page (the app knows its own). */
export async function readSpace(open: string[] = []): Promise<Space | null> {
  if (isNative) return nativeSpace().catch(() => null);
  const c = await readCapacity();
  const items: Item[] = [];
  for (const r of await store.list()) {
    const s = repoState(r.name);
    const [room, why]: [Item['room'], string] = open.includes(r.name) ? ['Keep', t('A Prompt has it open')]
      : !connection() ? ['Keep', t('Connect to the Remote to free it')]
      : !kept ? ['Keep', t('This browser lets it go when the page closes')]
      : s?.where === 'synced' ? ['Free', t('The Remote has the same; opening it brings it back')]
      : ['SyncFree', s?.changed ? t('{n} changes are sent, then it is freed', {n: s.changed}) : t('Its changes are sent, then it is freed')];
    const works = store.copies(r.name).length - 1;
    items.push({id: `repo:${r.name}`, what: r.name, detail: works ? t('repo · {files} · {n} works', {files: tn('{n} file', '{n} files', r.files), n: works}) : `repo · ${tn('{n} file', '{n} files', r.files)}`, allocated: r.bytes, room, why});
  }
  items.sort((a, b) => b.allocated - a.allocated || a.what.localeCompare(b.what));
  return {
    host_total: c?.total ?? 0, host_free: c?.free ?? 0, host: 'Estimated',
    allocated: c?.app ?? items.reduce((n, i) => n + i.allocated, 0),
    freeable: items.filter((i) => i.room !== 'Keep').reduce((n, i) => n + i.allocated, 0), items,
  };
}

/** 空ける these; each repo is sent first and goes only once the Remote has all of it. */
export async function free(ids: string[]): Promise<Freed> {
  let result: Freed;
  if (isNative) {
    await flush();
    result = await nativeFree(ids);
  } else {
    const before = (await readCapacity())?.free ?? 0;
    const removed: string[] = [], kept_: [string, string][] = [];
    let freed = 0;
    await flush();
    for (const id of ids) {
      const name = id.replace(/^repo:/, '');
      const size = (await store.list()).find((r) => r.name === name)?.bytes ?? 0;
      try {
        const s = await draft.sync(name);
        if (s.both.length) throw new Error(t('Another device\'s change was put beside yours; check it before freeing ({path})', {path: s.both[0]}));
        const left = (await draft.status()).find((x) => x.name === name);
        if (left?.changed) throw new Error(t('It changed while syncing; try again'));
        await kept!.letGo([name]);
        await draft.forget(name);
        removed.push(id);
        freed += size;
      } catch (e) { kept_.push([id, e instanceof Error ? e.message : String(e)]); }
    }
    const after = (await readCapacity())?.free ?? before;
    result = {freed, freed_certainty: 'Estimated', removed, kept: kept_, host_free_before: before, host_free_after: after, host_change: 'Estimated', reflected_ms: null};
  }
  // Whatever went is no longer here for Forge, File and Home either.
  for (const id of result.removed) if (id.startsWith('repo:')) store.changedOutside(id.slice(5), 'space');
  await look();
  return result;
}
