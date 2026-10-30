import type {Context} from '../context.ts';
import {ServerView} from './view.ts';
import {seenNow} from './talk.ts';

// Server as a place, gone to by pressing it on the rail (or a server in the servers a rest on its icon brings out,
// switcher.ts): its servers on its top line, its boards side by side, the box at its foot, its people at the right.

/** The Server page, built for who is here now; `again` draws it anew (the Remote answered, one signed in). */
export function serverPage(ctx: Context, again: () => void): Node[] {
  const view = new ServerView({ctx, again});
  // Escape from behind the gear, a repo shown, or a server being named: a step back to the boards.
  view.work.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented && view.back()) event.preventDefault();
  });
  // What is on the page is seen as it is drawn.
  requestAnimationFrame(() => seenNow());
  return [view.work];
}
