import type {Context} from '../kit/context.ts';
import {ServerView} from './view.ts';
import {seenNow} from './talk.ts';

// The room and its chooser above its working board, reached from the rail.

/** The Server page, built for who is here now; `again` draws it anew (the Remote answered, one signed in). */
export function serverPage(ctx: Context, again: () => void): Node[] {
  const view = new ServerView({ctx, again});
  // Escape puts away the chooser or comes back to the boards.
  view.work.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented && view.back()) event.preventDefault();
  });
  // What is on the page is seen as it is drawn.
  requestAnimationFrame(() => seenNow());
  return [view.work];
}
