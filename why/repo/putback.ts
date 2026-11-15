// Putting a file back as it was at the last commit (Forge's diff, Put back):
// given what the commit held, the copy here is made to hold it again.

import type {RepoStore} from './repos.ts';

/**
 * Make `path` in `repo` what the last commit held: `was` its text, or null
 * when the commit did not have it (it was added since, and goes). A file
 * removed since is written back, its folders made first.
 */
export async function restore(store: Pick<RepoStore, 'tree' | 'read' | 'write' | 'add' | 'mkdir' | 'remove'>, repo: string, path: string, was: string | null): Promise<void> {
  const here = await store.read(repo, path).then(() => true, () => false);
  if (was === null) { if (here) await store.remove(repo, path); return; }
  if (here) { await store.write(repo, path, was); return; }
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    if (!await store.tree(repo, dir).then(() => true, () => false)) await store.mkdir(repo, dir);
  }
  await store.add(repo, parts.slice(0, -1).join('/'), parts.at(-1)!, was);
}
