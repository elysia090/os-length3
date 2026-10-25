import {t, tn} from '../../i18n.ts';
import type {RepoSync} from '../../remote/lifecycle.ts';

// A repo as Remote's Repos shows it, and where it stands, in the words every list of repos uses (Home, Runtime).

/** Where a repo stands, in words. */
export function syncWord(s: RepoSync | undefined): string {
  if (!s) return '';
  if (s.where === 'local') return t('Only on this device');
  if (s.where === 'off') return t('Off on the Remote');
  if (s.where === 'waits') return t('Kept here · waits for room on the Remote');
  if (s.where === 'sending') return t('Sending');
  if (s.where === 'offline') {
    const not = s.changed ? tn('Not sent yet ({n} change)', 'Not sent yet ({n} changes)', s.changed) : t('Not sent yet');
    // Why, as the Remote (or this browser) said it: not reached, full, too large.
    return s.error ? `${not} · ${s.error}` : not;
  }
  if (s.unsynced.length) return tn('In step · {n} thing cannot be sent', 'In step · {n} things cannot be sent', s.unsynced.length);
  return t('In step');
}
