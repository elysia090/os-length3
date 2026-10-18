import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import {RemoteError} from '../remote.ts';
import * as servers from '../servers.ts';
import {postNow} from './talk.ts';
import {button, message, type Shown} from './server-parts.ts';
import {Drafts} from '../drafts.ts';

/**
 * A post half written stays with its board (DESIGN §1): going to another board, or putting the
 * layer away, keeps it, and it is there when the board is on screen again; gone once sent. A
 * guest's is kept apart from one of its people's.
 */
const drafts = new Drafts();

/** What the box at the foot needs of the layer it is in. */
export interface DockWays {
  signedIn: boolean;
  /** Brought out by a press: the box takes the focus. */
  pinned(): boolean;
  /** Something being written here keeps the layer out. */
  writing(busy: () => boolean): void;
  /** Words in the box: a press outside does not put the layer away. */
  holding(words: () => boolean): void;
  /** Away to the Remote page, to sign in. */
  signIn(): void;
  /** In as a guest, or no longer one: what lists the boards one writes in is drawn again. */
  guestChanged(): void;
}

/**
 * The box at the foot, for the board on screen: a member writes to its
 * people, a guest as a guest; one who came by an invitation chooses the name
 * they write as; anyone else is told who writes here.
 */
export function dockFor(b: Shown | null, ways: DockWays): Node[] {
  if (!b) return [];
  const note = h('p', {class: 'prompt-note muted small', role: 'status'});
  const guest = !b.member && b.guests ? servers.guestOf(b.id) : null;
  /** Removed, or the lease ran out (the Remote says 403): said so, and the box gives way. */
  const noLonger = (e: unknown) => {
    if (!(e instanceof RemoteError) || e.status !== 403 || !note.isConnected) return;
    servers.forgetGuest(b.id);
    const parent = note.parentElement;
    parent?.replaceChildren(...dockFor(b, ways));
    parent?.querySelector('.prompt-note')?.replaceChildren(t('You no longer write here as a guest.'));
    ways.guestChanged();
  };
  if (guest) void servers.guestStill(b.id, guest.token).catch(noLonger);
  if (b.member || guest) {
    const field = h('textarea', {class: 'prompt-in', rows: '1', maxlength: String(servers.LIMIT), 'aria-label': t('Write in {board}', {board: b.name}),
      placeholder: b.member ? t('To the people of {server}', {server: b.server}) : t('As {name}, a guest', {name: guest!.as})}) as HTMLTextAreaElement;
    const key = `${b.member ? 'member' : 'guest'}:${b.id}`;
    field.value = drafts.get(key);
    ways.writing(() => document.activeElement === field || !!field.value.trim());
    ways.holding(() => drafts.holds(key));
    const fit = () => { field.style.height = 'auto'; field.style.height = `${field.scrollHeight}px`; };
    let sending = false;
    field.addEventListener('input', () => { drafts.set(key, field.value); fit(); });
    if (field.value) queueMicrotask(fit);
    field.addEventListener('keydown', async (event) => {
      // As every box one writes in: Enter is a new line, Ctrl+Enter (⌘+Enter) sends.
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
      event.preventDefault();
      if (sending || !field.value.trim()) return;
      sending = true;
      note.replaceChildren();
      try { await postNow(b.id, field.value, guest?.token); field.value = ''; drafts.sent(key); fit(); } catch (e) {
        note.textContent = message(e);
        if (guest) noLonger(e);
      } finally { sending = false; }
    });
    if (ways.pinned() && b.member) queueMicrotask(() => { field.focus(); field.setSelectionRange(field.value.length, field.value.length); });
    return [h('form', {class: 'prompt'}, field), note];
  }
  const held = servers.heldInvite();
  if (b.guests && held?.board === b.id) return [guestIn(b, held.code, ways), note];
  const signIn = button(t('Sign in'), 'small-button');
  signIn.addEventListener('click', () => ways.signIn());
  const why = b.guests ? t('Guests write here when one of its people invites them.') : ways.signedIn ? t('Only its people write here.') : t('Sign in to write.');
  return [h('div', {class: 'prompt server-say'}, h('span', {class: 'muted'}, why), ways.signedIn ? null : signIn), note];
}

/**
 * One who came by an invitation: the name they will write as (shown with
 * "guest" beside it, never as one of its people's), then the box. Nothing
 * else is asked: the invitation is the proof.
 */
function guestIn(b: Shown, code: string, ways: DockWays): HTMLElement {
  const name = h('input', {class: 'line-in', maxlength: '32', placeholder: t('Your name here'), 'aria-label': t('Your name here'), autocomplete: 'nickname'}) as HTMLInputElement;
  const join = button(t('Write as a guest'), 'small-button primary');
  const error = h('span', {class: 'error small', role: 'alert'});
  ways.writing(() => document.activeElement === name || !!name.value.trim());
  const box = h('div', {class: 'prompt server-say'}, h('span', {class: 'muted'}, t('You are invited to write in #{board}.', {board: b.name})), name, join, error,
    h('span', {class: 'muted small'}, t('Your name is shown with "guest" beside it.')));
  const go = async () => {
    if (!name.value.trim() || join.disabled) { name.focus(); return; }
    join.disabled = true;
    error.textContent = '';
    try {
      await servers.guestJoin(b, code, name.value);
      // In: the guest's box in its place.
      box.parentElement?.replaceChildren(...dockFor(b, ways));
      ways.guestChanged();
    } catch (e) {
      join.disabled = false;
      error.textContent = message(e);
      // An invitation that opens nothing is let go: asking again with it cannot help.
      if (e instanceof RemoteError && e.status === 403) { servers.dropInvite(); name.disabled = join.disabled = true; }
    }
  };
  join.addEventListener('click', () => void go());
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void go(); } });
  if (ways.pinned()) queueMicrotask(() => name.focus());
  return box;
}
