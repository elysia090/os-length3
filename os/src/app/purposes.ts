// The leftmost rail chooses a purpose and the whole main area shows it;
// there is no intermediate pane. File and Server are the operations among
// them: File lays the tree of "/" over the page, Server the people one knows
// and their boards, instead of replacing it. Every purpose is about repos
// but Server, whose subject is people. Purposes are not directories: the
// filesystem stays an ordinary POSIX tree and never re-implements this
// classification.

export type PurposeId =
  | 'home' | 'file' | 'git' | 'forge' | 'runtime' | 'remote' | 'server' | 'inbox' | 'plugin'
  | 'new-repo';

/** Label, role and detail are English; they are shown through t(). */
export interface Purpose {
  readonly id: PurposeId;
  readonly label: string;
  /** What the purpose is for, in one phrase. */
  readonly role: string;
  /** What the page will hold once the surface is real. */
  readonly detail: string;
  /** Whether the page shows real state yet. */
  readonly implemented: boolean;
}

export const PURPOSES: readonly Purpose[] = [
  {id: 'home', label: 'Home', role: 'Profile',
    detail: 'A public profile page showing your repos and servers.', implemented: true},
  {id: 'file', label: 'File', role: 'Directory tree (/)',
    detail: 'Opens the system root (/) over the current page. Selecting a repo file opens it in Forge.', implemented: true},
  {id: 'forge', label: 'Forge', role: 'Workspace',
    detail: 'Edit files from repos in the band in a continuous view, with Reference and Prompt on the right.', implemented: true},
  {id: 'git', label: 'Git', role: 'Issues and commits',
    detail: 'Work by Issue: commit, push, and submit to main as a Change. Review incoming Changes to Merge or Reject.', implemented: true},
  {id: 'runtime', label: 'Runtime', role: 'This device and environments',
    detail: 'Storage usage by size. Free up space instantly. Manage active environments.', implemented: true},
  {id: 'remote', label: 'Remote', role: 'Repo storage',
    detail: 'Where your repos are kept. Changes sync instantly; commits record history. Manage devices and passkeys.', implemented: true},
  // Under the cloud: the people one knows, on the Remote, with what they show of their repos.
  {id: 'server', label: 'Server', role: 'Contacts',
    detail: 'A group workspace. Each board combines discussions and a shared TODO list.', implemented: true},
  {id: 'inbox', label: 'Inbox', role: 'Notifications',
    detail: 'Review requests, Changes, and questions, with context and action items.', implemented: true},
  // The plug: an area at the top of the center, opened over the work rather than a page of its own.
  {id: 'plugin', label: 'Plugin', role: 'Optional plugins',
    detail: 'Opens the top plugin bar. Hidden until toggled; holds up to seven plugins side by side.', implemented: true},
];

/** The round + under the rail's places: create a repo, not a purpose view. */
export const NEW_REPO: Purpose = {id: 'new-repo', label: 'New repo', role: 'Create a repo',
  detail: 'Choose a standard template to create a standalone repo.', implemented: true};

/** Rail order, top to bottom, as keyboard navigation walks it. */
export const RAIL: readonly Purpose[] = [...PURPOSES, NEW_REPO];

export const DEFAULT_PURPOSE: PurposeId = 'home';

export function purpose(id: PurposeId): Purpose {
  const found = RAIL.find((p) => p.id === id);
  if (!found) throw new Error(`unknown purpose ${id}`);
  return found;
}

/**
 * A stored value is a convenience only; anything unknown falls back to Home.
 * Creating a repo is a step, not a place to reopen the app into, and File
 * and the plug are operations over a page.
 */
export function restorePurpose(stored: string | null | undefined): PurposeId {
  // File and the plug open over a page and are never the page itself.
  return PURPOSES.some((p) => p.id === stored && !OVER.includes(p.id)) ? stored as PurposeId : DEFAULT_PURPOSE;
}

/** The purposes laid over a page rather than shown as one. */
const OVER: readonly PurposeId[] = ['file', 'plugin'];

/**
 * Vertical rail keys, wrapping at both ends like a tab list. Returns null for
 * keys the rail does not handle so other shortcuts keep working.
 */
export function stepPurpose(current: PurposeId, key: string): PurposeId | null {
  const at = RAIL.findIndex((p) => p.id === current);
  const last = RAIL.length - 1;
  const next = key === 'ArrowDown' ? (at + 1) % RAIL.length
    : key === 'ArrowUp' ? (at + last) % RAIL.length
    : key === 'Home' ? 0
    : key === 'End' ? last
    : null;
  return next === null ? null : RAIL[next].id;
}
