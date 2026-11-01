import {h} from '../../ui/dom.ts';
import {errorText} from '../../app/errors.ts';
import {t} from '../../i18n.ts';
import * as account from '../../remote/connection.ts';

// The pieces Remote's parts share (sign-in, repos, the Sign-in part, devices, plan).

export function button(text: string, kind = ''): HTMLButtonElement {
  return h('button', {class: `button ${kind}`.trim(), type: 'button'}, text) as HTMLButtonElement;
}

/** Run `f` with `b` pressed down, saying any failure in `error`. */
export async function pressing(b: HTMLButtonElement, error: HTMLElement, f: () => Promise<void>) {
  b.disabled = true;
  error.textContent = '';
  try { await f(); } catch (e) { error.textContent = errorText(e); } finally { b.disabled = false; }
}

/**
 * A passkey's deed or a provider's in the app (adding a passkey, linking a provider, setting the code): the browser's,
 * opened at Remote's Sign-in, and said in `note`; what it changed is read again (`again`) when the window comes back.
 */
export async function atSignIn(note: HTMLElement, again: () => unknown) {
  await account.askBrowser('sign-in');
  note.textContent = t('Opened at Sign-in in browser. Return after completing to refresh.');
  addEventListener('focus', () => { note.textContent = ''; void again(); }, {once: true});
}
