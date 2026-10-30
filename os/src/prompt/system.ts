// "/" is the root of the whole system, the same tree the Prompt's shell
// sees: in the app, the root installed on this machine (core/src/root.rs
// list); in a browser, l3's root (userland.ts), read from its index. Each top-level
// directory says where it comes from: the distribution (l3), the kernel
// (/dev, /proc, /sys, made when a shell starts), the person's repos
// (/root), or nothing (/tmp, /run start empty).

import {isNative, native} from '../app/host.ts';
import {t} from '../i18n.ts';
import {store} from '../repos/repos.ts';
import {l3Index} from './userland.ts';

export type Origin = 'distribution' | 'kernel' | 'repos' | 'empty';

export interface SystemEntry {
  name: string;
  kind: 'dir' | 'file' | 'link' | 'device';
  /** Absolute path. */
  path: string;
  size?: number;
  target?: string;
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

/** What the kernel makes, and what starts empty, whatever the root has there. */
const KERNEL = new Set(['dev', 'proc', 'sys']);
const EMPTY = new Set(['tmp', 'run']);

/** The repo and the path inside it, for a path under /root/<repo>. */
export function inRepo(path: string): {repo: string; path: string} | null {
  const m = /^\/root\/([^/]+)(?:\/(.*))?$/.exec(path);
  return m ? {repo: m[1], path: m[2] ?? ''} : null;
}

const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

/** Every entry of l3's root under each directory, from its index (what l3 this build carries; none without one). */
let distribution: Promise<Map<string, SystemEntry[]>> | null = null;
async function root(): Promise<Map<string, SystemEntry[]>> {
  const index = await l3Index();
  if (!index) throw new Error(t('Distribution not fetched'));
  const under = new Map<string, SystemEntry[]>();
  const add = (e: SystemEntry) => {
    const dir = e.path.slice(0, e.path.lastIndexOf('/')) || '/';
    if (!under.has(dir)) under.set(dir, []);
    under.get(dir)!.push(e);
  };
  const name = (p: string) => p.slice(p.lastIndexOf('/') + 1);
  for (const d of index.dirs) add({name: name(d.path), kind: 'dir', path: d.path});
  for (const l of index.links) add({name: name(l.path), kind: 'link', path: l.path, target: l.target});
  for (const f of index.files) add({name: name(f.path), kind: 'file', path: f.path, size: f.size});
  for (const list of under.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return under;
}

/** At "/", each top-level directory says where it comes from. */
function origins(path: string, entries: SystemEntry[]): SystemEntry[] {
  if (path !== '/') return entries;
  return entries.map((e) => (e.kind !== 'dir' ? e : {...e,
    origin: e.name === 'root' ? 'repos' : KERNEL.has(e.name) ? 'kernel' : EMPTY.has(e.name) ? 'empty' : 'distribution'}));
}

export async function list(path: string): Promise<SystemEntry[]> {
  if (path === '/root') {
    return (await store.list()).map((r) => ({name: r.name, kind: 'dir', path: `/root/${r.name}`}));
  }
  if (path === '/dev') return ['null', 'random', 'urandom', 'zero'].map((name) => ({name, kind: 'device', path: `/dev/${name}`}));
  const at = inRepo(path);
  if (at) {
    return (await store.tree(at.repo, at.path)).map((e) => ({name: e.name, kind: e.kind, path: join(path, e.name), size: e.size}));
  }
  // Anything else is the root: in the app, the one installed here, read as it is on the disk.
  if (isNative) return origins(path, await native<SystemEntry[]>('root_list', {path}).catch((e) => {
    // No root yet: "/" still has /root, the repos, which are this device's own; the rest comes with a root (Runtime).
    if (path === '/') return [{name: 'root', kind: 'dir' as const, path: '/root'}];
    throw e;
  }));
  // In a browser, l3's root as its index has it: the same tree as the app's.
  distribution ??= root().catch((e) => { distribution = null; throw e; });
  // Its index not here yet (offline, or l3 still on its way): "/" still has /root, the repos, which are this
  // device's own; the rest of the tree comes with l3.
  const entries = path === '/' ? await distribution.then((d) => d.get('/') ?? [], () => [{name: 'root', kind: 'dir' as const, path: '/root'}])
    : (await distribution).get(path) ?? [];
  return origins(path, entries);
}
