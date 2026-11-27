// The rail lists the places, top to bottom; the world lies left to right in that same order (ui/glide.ts travel).
// The order is how far a place is from the person, nearest first: Home (mine), Forge (the work), Server (people),
// Runtime (the machine). Then come File and the plug, called up in front of a place, and +, which makes a repo.
//
// Git and Forge are peers on the same work level; both have the Places key. The Remote and Inbox are still each a
// place's far side, reached by the door at the head of that place: Home's repos where they are kept and Server's
// conversations. Purposes are not directories; the filesystem is an ordinary POSIX tree.

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
  /** Which of the rail's groups it stands in. */
  readonly group: 'mine' | 'work' | 'people' | 'machine' | 'tools';
}

/** Every page, with related pages together. */
export const PURPOSES: readonly Purpose[] = [
  {id: 'home', label: 'Home', role: 'Profile', group: 'mine',
    detail: 'A public profile page showing your repos and servers.', implemented: true},
  {id: 'remote', label: 'Remote', role: 'Repo storage', group: 'mine',
    detail: 'Where your repos are kept. Changes sync instantly; commits record history. Manage devices and passkeys.', implemented: true},
  {id: 'forge', label: 'Forge', role: 'Workspace', group: 'work',
    detail: 'Edit files from repos in the band in a continuous view, with Reference and Prompt on the right.', implemented: true},
  {id: 'git', label: 'Git', role: 'Issues and commits', group: 'work',
    detail: 'Work by Issue: commit, push, and submit to main as a Change. Review incoming Changes to Merge or Reject.', implemented: true},
  // The people one knows, on the Remote, with what they show of their repos.
  {id: 'server', label: 'Server', role: 'Contacts', group: 'people',
    detail: 'A group workspace. Each board combines discussions and a shared TODO list.', implemented: true},
  {id: 'inbox', label: 'Inbox', role: 'Notifications', group: 'people',
    detail: 'Review requests, Changes, and questions, with context and action items.', implemented: true},
  {id: 'runtime', label: 'Runtime', role: 'This device and environments', group: 'machine',
    detail: 'Storage usage by size. Free up space instantly. Manage active environments.', implemented: true},
  {id: 'file', label: 'File', role: 'Directory tree (/)', group: 'tools',
    detail: 'Opens the system root (/) over the current page. Selecting a repo file opens it in Forge.', implemented: true},
  // The plug: an area at the top of the center, opened over the work rather than a page of its own.
  {id: 'plugin', label: 'Plugin', role: 'Optional plugins', group: 'tools',
    detail: 'Opens the top plugin bar. Hidden until toggled; holds up to seven plugins side by side.', implemented: true},
];

/** The round + under the rail's places: create a repo, not a purpose view. */
export const NEW_REPO: Purpose = {id: 'new-repo', label: 'New repo', role: 'Create a repo', group: 'tools',
  detail: 'Choose a standard template to create a standalone repo.', implemented: true};

/** The place each page with no icon is the far side of. */
const FAR: Partial<Record<PurposeId, PurposeId>> = {remote: 'home', inbox: 'server'};
/** Whether the page uses the unobtrusive work Places key instead of a permanent rail. */
export const isWorkPage = (id: PurposeId) => id === 'forge' || id === 'git';
/** Depth and rail continuity: the two work pages share one rail position, but neither is the other's door. */
export const placeOf = (id: PurposeId): PurposeId => id === 'git' ? 'forge' : FAR[id] ?? id;
/** Where the door of `id` leads: from a place to its far side, from a far side back to its place; none where a place has no far side. */
export function doorOf(id: PurposeId): PurposeId | null {
  if (FAR[id]) return FAR[id]!;
  const far = (Object.keys(FAR) as PurposeId[]).find((k) => FAR[k] === id);
  return far ?? null;
}
/** Whether `id` is a place's far side: a step along from its place. */
export const isFar = (id: PurposeId): boolean => id in FAR;

/** Rail order, top to bottom, as keyboard navigation walks it: the places, then what is not a place. */
export const RAIL: readonly Purpose[] = [...PURPOSES.filter((p) => !(p.id in FAR) && p.id !== 'git'), NEW_REPO];

/** Where a page lies in the world, to the right of Home: its place's number on the rail. */
export const depth = (id: PurposeId): number => RAIL.findIndex((p) => p.id === placeOf(id));

export const DEFAULT_PURPOSE: PurposeId = 'home';

export function purpose(id: PurposeId): Purpose {
  const found = id === NEW_REPO.id ? NEW_REPO : PURPOSES.find((p) => p.id === id);
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
