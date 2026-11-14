// "/" is the root of the whole system, the same tree the Prompt's shell
// sees: in the app, the root installed on this machine (ricebox's list,
// through the core); in a browser, the root as its index has it (ricebox's
// layers/tree.ts). Each top-level directory says where it comes from: the
// distribution, the kernel (/dev, /proc, /sys, made when a box starts) or
// nothing (/tmp, /run start empty), which ricebox says; or the person's
// repos (/root), which is why's to say.

import {devices, madeBy, treeOf, type TreeEntry} from '../../../module/ricebox/layers/tree.ts';
import {native, rootHere} from '../host/host.ts';
import {t} from '../i18n/i18n.ts';
import {shownTree, store} from '../repos/repos.ts';

export type Origin = 'distribution' | 'kernel' | 'repos' | 'empty';

export interface SystemEntry extends TreeEntry {
  /** Top-level directories only. */
  origin?: Origin;
}

/** In English; shown through t(). */
export const ORIGIN_LABEL: Record<Origin, string> = {
  distribution: 'distribution',
  kernel: 'kernel',
  repos: 'repo',
  empty: 'empty',
};

/** The repo and the path inside it, for a path under /root/<repo>. */
export function inRepo(path: string): {repo: string; path: string} | null {
  const m = /^\/root\/([^/]+)(?:\/(.*))?$/.exec(path);
  return m ? {repo: m[1], path: m[2] ?? ''} : null;
}

const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

/** Every entry of the root under each directory, from its index (the root this build carries; none without one). */
let distribution: Promise<Map<string, SystemEntry[]>> | null = null;
async function root(): Promise<Map<string, SystemEntry[]>> {
  // The root's own module, brought when it is first listed: the tree of / is drawn without the Prompt's machine.
  const index = await (await import('./userland.ts')).whyIndex();
  if (!index) throw new Error(t('Distribution not fetched'));
  return treeOf(index);
}

/** At "/", each top-level directory says where it comes from. */
function origins(path: string, entries: SystemEntry[]): SystemEntry[] {
  if (path !== '/') return entries;
  return entries.map((e) => (e.kind !== 'dir' ? e : {...e, origin: e.name === 'root' ? 'repos' : madeBy(e.name)}));
}

export async function list(path: string): Promise<SystemEntry[]> {
  if (path === '/root') {
    return (await store.names()).map((name) => ({name, kind: 'dir', path: `/root/${name}`}));
  }
  if (path === '/dev') return devices();
  const at = inRepo(path);
  if (at) {
    return (await shownTree(at.repo, at.path)).map((e) => ({name: e.name, kind: e.kind, path: join(path, e.name), size: e.size}));
  }
  // Anything else is the root: in the app, the one installed here, read as it is on the disk.
  if ((await rootHere()).native) return origins(path, await native<SystemEntry[]>('root_list', {path}).catch((e) => {
    // No root yet: "/" still has /root, the repos, which are this device's own; the rest comes with a root (Runtime).
    if (path === '/') return [{name: 'root', kind: 'dir' as const, path: '/root'}];
    throw e;
  }));
  // In a browser, why's root as its index has it: the same tree as the app's.
  distribution ??= root().catch((e) => { distribution = null; throw e; });
  // Its index not here yet (offline, or why still on its way): "/" still has /root, the repos, which are this
  // device's own; the rest of the tree comes with why.
  const entries = path === '/' ? await distribution.then((d) => d.get('/') ?? [], () => [{name: 'root', kind: 'dir' as const, path: '/root'}])
    : (await distribution).get(path) ?? [];
  return origins(path, entries);
}
