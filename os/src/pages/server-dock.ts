import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import * as servers from '../servers.ts';
import {postNow} from './talk.ts';
import {button, message, type Shown} from './server-parts.ts';

/** What the box at the foot needs of the layer it is in. */
export interface DockWays {
  signedIn: boolean;
  /** Brought out by a press: the box takes the focus. */
  pinned(): boolean;
  /** Something being written here keeps the layer out. */
  writing(busy: () => boolean): void;
  /** Away to the Remote page, to sign in. */
  signIn(): void;
}

/**
 * The box at the foot, for the board on screen: a member writes to its
 * people, a guest (once their email is checked) as a guest; an outsider
 * where the board takes guests is asked for an email and the code sent to
 * it; anyone else is told who writes here.
 */
export function dockFor(b: Shown | null, ways: DockWays): Node[] {
  if (!b) return [];
  const note = h('p', {class: 'prompt-note muted small', role: 'status'});
  const guest = !b.member && b.guests ? servers.guestOf(b.id) : null;
  if (b.member || guest) {
    const field = h('textarea', {class: 'prompt-in', rows: '1', maxlength: String(servers.LIMIT), 'aria-label': t('Write in {board}', {board: b.name}),
      placeholder: b.member ? t('To the people of {server}', {server: b.server}) : t('As {name}, a guest', {name: guest!.as})}) as HTMLTextAreaElement;
    ways.writing(() => document.activeElement === field || !!field.value.trim());
    const fit = () => { field.style.height = 'auto'; field.style.height = `${field.scrollHeight}px`; };
    let sending = false;
    field.addEventListener('input', fit);
    field.addEventListener('keydown', async (event) => {
      // As every box one writes in: Enter is a new line, Ctrl+Enter (⌘+Enter) sends.
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
      event.preventDefault();
      if (sending || !field.value.trim()) return;
      sending = true;
      note.replaceChildren();
      try { await postNow(b.id, field.value, guest?.token); field.value = ''; fit(); } catch (e) { note.textContent = message(e); } finally { sending = false; }
    });
    if (ways.pinned() && b.member) queueMicrotask(() => field.focus());
    return [h('form', {class: 'prompt'}, field), note];
  }
  if (b.guests) return [guestIn(b, ways), note];
  const signIn = button(t('Sign in'), 'small-button');
  signIn.addEventListener('click', () => ways.signIn());
  return [h('div', {class: 'prompt server-say'},
    h('span', {class: 'muted'}, ways.signedIn ? t('Only its people write here.') : t('Sign in to write.')), ways.signedIn ? null : signIn)];
}

/** An outsider, where the board takes guests: an email, the code sent to it, then the box. */
function guestIn(b: Shown, ways: DockWays): HTMLElement {
  const email = h('input', {class: 'line-in', type: 'email', placeholder: t('Your email'), 'aria-label': t('Your email')}) as HTMLInputElement;
  const code = h('input', {class: 'line-in', inputmode: 'numeric', maxlength: '6', placeholder: t('The code sent to it'), 'aria-label': t('Code'), hidden: ''}) as HTMLInputElement;
  const ask = button(t('Send a code'), 'small-button');
  const error = h('span', {class: 'error small', role: 'alert'});
  ways.writing(() => [email, code].includes(document.activeElement as HTMLInputElement));
  const box = h('div', {class: 'prompt server-say'}, h('span', {class: 'muted'}, t('Write as a guest:')), email, code, ask, error);
  ask.addEventListener('click', async () => {
    error.textContent = '';
    try {
      if (code.hidden) { await servers.guestCode(b.id, email.value); code.hidden = false; ask.textContent = t('Check'); code.focus(); return; }
      await servers.guestCheck(b.id, email.value, code.value);
      // Checked: the guest's box in its place.
      box.parentElement?.replaceChildren(...dockFor(b, ways));
    } catch (e) { error.textContent = message(e); }
  });
  return box;
}
