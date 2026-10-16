// The leftmost rail chooses a purpose and the whole main area shows it;
// there is no intermediate pane. File is the one operation among them: it
// lays the tree of "/" over the page instead of replacing it. Purposes are not directories: the
// filesystem stays an ordinary POSIX tree and never re-implements this
// classification.

export type PurposeId =
  | 'home' | 'file' | 'git' | 'forge' | 'runtime' | 'remote' | 'topic' | 'inbox'
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
    detail: 'A page that reads the same to you and to anyone else, with your repos and posts.', implemented: true},
  {id: 'forge', label: 'Forge', role: 'Your workshop',
    detail: 'Edit the files of the repos in the band as one continuous page, with Reference and Prompt on the right.', implemented: true},
  {id: 'file', label: 'File', role: 'The tree of /',
    detail: 'Opens the whole system\'s / over the current page. Choosing something inside a repo opens it there in Forge.', implemented: true},
  {id: 'git', label: 'Git', role: 'Issues and commits',
    detail: 'Commit changes Issue by Issue and submit them. Changes that come in are settled with Merge or Reject.', implemented: true},
  {id: 'runtime', label: 'Runtime', role: 'This device and its environments',
    detail: 'What this device holds, largest first. What can be freed is freed right there. The active environments too.', implemented: true},
  {id: 'remote', label: 'Remote', role: 'The canonical copy',
    detail: 'Where the canonical copy lives. What you change is sent at once, and committing makes it history. Devices and passkeys are here too.', implemented: true},
  {id: 'topic', label: 'Topic', role: 'Simple posts',
    detail: 'Share short things, like what is popular lately.', implemented: false},
  {id: 'inbox', label: 'Inbox', role: 'Typed messages to you',
    detail: 'Review requests, submitted changes, questions and more, each with what it is about and what to do.', implemented: false},
];

/** The round + under the rail's places: create a repo, not a purpose view. */
export const NEW_REPO: Purpose = {id: 'new-repo', label: 'New repo', role: 'Make a repo',
  detail: 'Choose a standard repo template and make it as an independent repo.', implemented: true};

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
 * is an operation over a page.
 */
export function restorePurpose(stored: string | null | undefined): PurposeId {
  // File opens over a page and is never the page itself.
  return PURPOSES.some((p) => p.id === stored && p.id !== 'file') ? stored as PurposeId : DEFAULT_PURPOSE;
}

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
