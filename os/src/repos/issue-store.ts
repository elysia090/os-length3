// Where issues are kept: main's copy of a repo, whatever work it shows now (an issue is main's, the same issue from
// the work on it as from anywhere else), and history at once. Each issue's file is committed on main by itself as it
// is written, its words changed, closed or reopened (core history.rs commit_issue): main's card holds only the
// person's own files, a work starts from a main that has every issue, and a work's change never carries one.
// Signed out, an issue is written and waits; Git commits what waits once there is a Remote (settle).

import {core} from '../app/host.ts';
import type {Commits, IssueDeed} from './issues.ts';
import {store, type Contents, type Entry, type RepoStore} from './repos.ts';

/** Written on main: what shows that path here hears of it (Forge's file, a Prompt's copy, Git), as any write. */
const told = (repo: string, path: string) => store.changedPaths(repo, [path]);

export const issueStore: Pick<RepoStore, 'tree' | 'read' | 'write' | 'add' | 'mkdir' | 'remove'> & Required<Commits> = {
  tree: (repo, path) => core<Entry[]>('repo_tree', {repo, path, main: true}),
  read: (repo, path) => core<Contents>('repo_read', {repo, path, main: true}),
  async write(repo, path, text) {
    const n = await core<number>('repo_write', {repo, path, text, main: true});
    await told(repo, path);
    return n;
  },
  async add(repo, dir, name, text) {
    const n = await core<number>('repo_add', {repo, dir, name, text, main: true});
    await told(repo, `${dir}/${name}`);
    return n;
  },
  async mkdir(repo, path) {
    await core<void>('repo_mkdir', {repo, path, main: true});
    await told(repo, path);
  },
  async remove(repo, path) {
    await core<void>('repo_remove', {repo, path, main: true});
    await told(repo, path);
  },
  // Not made (the Remote away, or refusing) is no failure of the write: it waits, and settle commits it later.
  commit: (repo: string, path: string, deed: IssueDeed) => core<boolean>('issue_commit', {repo, file: path, deed}).catch(() => false),
  settle: (repo: string) => core<number>('issues_settle', {repo}).catch(() => 0),
};
