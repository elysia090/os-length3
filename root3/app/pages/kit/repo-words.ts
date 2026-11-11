// What a repo's card says of it on Home and on Remote: its own words.

import {store} from '../../repos/repos.ts';

/** A repo's README's first line that is neither a heading nor empty ('' when there is none): Home's and Remote's cards. */
export async function summaryOf(name: string): Promise<string> {
  const c = await store.read(name, 'README.md').catch(() => null);
  return c?.text?.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#')) ?? '';
}
