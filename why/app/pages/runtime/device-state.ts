import type {Freed, Space} from '../../../api/host.ts';
import type {RepoSync} from '../../../shipto/lifecycle.ts';
import type {RemoteRepo} from '../../../repo/sync.ts';

/** Every input drawn by device(): sync can change without changing a single storage byte. */
export function deviceStateKey(space: Space, last: Freed | null, states: readonly (RepoSync | undefined)[], remote: readonly RemoteRepo[], connected: boolean): string {
  return JSON.stringify({space: {...space, kept: false}, last, states, remote, connected});
}
