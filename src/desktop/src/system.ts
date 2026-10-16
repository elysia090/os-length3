// "/" is the root of the whole system, the same tree the Terminal's shell
// sees. Each top-level directory comes from one place: /bin is the fetched
// distribution, /dev and /proc are made by the kernel when a shell starts,
// /root holds the person's repos, and /etc and /tmp start empty.

import {t} from './i18n.ts';
import {store} from './repos.ts';

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

const TOP: readonly {name: string; origin: Origin}[] = [
  {name: 'bin', origin: 'distribution'},
  {name: 'dev', origin: 'kernel'},
  {name: 'etc', origin: 'empty'},
  {name: 'proc', origin: 'kernel'},
  {name: 'root', origin: 'repos'},
  {name: 'tmp', origin: 'empty'},
];

/** Where the distribution is fetched from. */
export const DISTRIBUTION = '/userland';

/** The repo and the path inside it, for a path under /root/<repo>. */
export function inRepo(path: string): {repo: string; path: string} | null {
  const m = /^\/root\/([^/]+)(?:\/(.*))?$/.exec(path);
  return m ? {repo: m[1], path: m[2] ?? ''} : null;
}

const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

let distribution: Promise<SystemEntry[]> | null = null;

async function bin(): Promise<SystemEntry[]> {
  const [applets, head] = await Promise.all([
    fetch(`${DISTRIBUTION}/applets`).then((r) => {
      if (!r.ok) throw new Error(t('The distribution has not been fetched'));
      return r.text();
    }),
    fetch(`${DISTRIBUTION}/busybox`, {method: 'HEAD'}),
  ]);
  const size = Number(head.headers.get('content-length') ?? 0);
  const links = applets.split('\n').filter((a) => a && a !== 'busybox').sort()
    .map((a): SystemEntry => ({name: a, kind: 'link', path: `/bin/${a}`, target: 'busybox'}));
  return [{name: 'busybox', kind: 'file', path: '/bin/busybox', size}, ...links];
}

export async function list(path: string): Promise<SystemEntry[]> {
  if (path === '/') return TOP.map((t) => ({name: t.name, kind: 'dir', path: `/${t.name}`, origin: t.origin}));
  if (path === '/bin') {
    distribution ??= bin().catch((e) => { distribution = null; throw e; });
    return distribution;
  }
  if (path === '/dev') return ['null', 'random', 'urandom', 'zero'].map((name) => ({name, kind: 'device', path: `/dev/${name}`}));
  if (path === '/root') {
    return (await store.list()).map((r) => ({name: r.name, kind: 'dir', path: `/root/${r.name}`}));
  }
  const at = inRepo(path);
  if (at) {
    return (await store.tree(at.repo, at.path)).map((e) => ({name: e.name, kind: e.kind, path: join(path, e.name), size: e.size}));
  }
  return [];
}
