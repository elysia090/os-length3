import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import * as account from '../../remote/connection.ts';
import {nudge} from '../../ui/glide.ts';
import {button} from './parts.ts';
import {signInPlace} from './sign-in.ts';

// The Remote out of reach, said in the place of what only it holds (Inbox, Server), on the sign-in card.

/** Whether `e` is the Remote not answering at all (not a refusal, nor a failure it said). */
export const unreachedError = (e: unknown): boolean => e instanceof account.RemoteError && e.trouble === 'unreached';

/** When Try again was last pressed: a card drawn again just after, the Remote still away, shakes its head. */
let tried = 0;

/**
 * What only the Remote holds, with the Remote out of reach: said where it would be, as signing in is (the same card,
 * in the same place), never a line of small print over an empty page. What it is that waits (`what`), and Try
 * again; `again` is called once, on that press or on its own the moment the Remote answers.
 */
export function unreachedPlace(what: string, again: () => void): HTMLElement {
  const retry = button(t('Try again'), 'small-button primary');
  const place = signInPlace(t('Cannot connect to Remote'), h('p', {class: 'muted'}, what), retry);
  let done = false;
  const once = () => { if (done) return; done = true; stop(); again(); };
  const stop = account.onReach(() => { if (!place.isConnected) { stop(); return; } if (!account.remoteAway()) once(); });
  retry.addEventListener('click', () => { retry.disabled = true; tried = Date.now(); once(); });
  if (Date.now() - tried < 4000) queueMicrotask(() => nudge(place.firstElementChild));
  return place;
}
