import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {nudge} from '../../ui/glide.ts';
import {RemoteError} from '../../remote/connection.ts';
import * as servers from '../../remote/servers.ts';
import {postNow} from './talk.ts';
import {button, type Shown} from './parts.ts';
import {Drafts} from '../../home/drafts.ts';
import {errorText} from '../../app/errors.ts';

/**
 * A post half written stays with its board (DESIGN §1): going to another board, or to another
 * page, keeps it, and it is there when the board is on screen again; gone once sent. A
 * guest's is kept apart from one of its people's.
 */
const drafts = new Drafts();

/** What the box at the foot needs of the page it is on. */
interface DockWays {
  signedIn: boolean;
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
    parent?.querySelector('.prompt-note')?.replaceChildren(t('Guest posting privileges have ended.'));
    ways.guestChanged();
  };
  if (guest) void servers.guestStill(b.id, guest.token).catch(noLonger);
  if (b.member || guest) return [writeIn(b, guest, note, noLonger), note];
  const held = servers.heldInvite();
  if (b.guests && held?.board === b.id) return [guestIn(b, held.code, ways), note];
  const signIn = button(t('Sign in'), 'small-button');
  signIn.addEventListener('click', () => ways.signIn());
  const why = b.guests ? t('Invited guests can post to this board.') : ways.signedIn ? t('Restricted to server members.') : t('Sign in to post.');
  return [h('div', {class: 'prompt server-say'}, h('span', {class: 'muted'}, why), ways.signedIn ? null : signIn), note];
}

/**
 * The box one of its people writes to them in, or a guest (`guest`) as a guest: what is half written kept with its
 * board, what went wrong sending said in `note`; a guest no longer let in is told so (`noLonger`).
 */
function writeIn(b: Shown, guest: servers.GuestHere | null, note: HTMLElement, noLonger: (e: unknown) => void): HTMLElement {
  const field = h('textarea', {class: 'prompt-in', rows: '1', maxlength: String(servers.LIMIT), 'aria-label': t('Post in #{board}', {board: b.name}),
    placeholder: b.member ? t('To members of {server}', {server: b.server}) : t('As guest ({name})', {name: guest!.as})}) as HTMLTextAreaElement;
  const key = `${b.member ? 'member' : 'guest'}:${b.id}`;
  field.value = drafts.get(key);
  const fit = () => { field.style.height = 'auto'; field.style.height = `${field.scrollHeight}px`; };
  // Post at the box's bottom right, as Forge's box has Run and Inbox's Send: what sends is in sight, not only known.
  // Its keys are in its title, as Run's are.
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const post = h('button', {type: 'button', class: 'button small-button prompt-run', title: t('Post ({keys})', {keys: mac ? '⌘+Enter' : 'Ctrl+Enter'}),
    'aria-keyshortcuts': mac ? 'Meta+Enter' : 'Control+Enter'}, t('Post')) as HTMLButtonElement;
  // Holding words or not: on a phone's width, where the box is narrow, Post comes with the words and leaves its room
  // to what the empty box says (styles.css).
  const form = h('form', {class: 'prompt'});
  const worded = () => form.classList.toggle('has-words', !!field.value.trim());
  let sending = false;
  const send = async () => {
    if (sending) return;
    // Nothing written: the box shakes its head, as every box does sent empty.
    if (!field.value.trim()) { field.focus(); nudge(field.closest('.prompt')); return; }
    sending = true;
    note.replaceChildren();
    try { await postNow(b.id, field.value, guest?.token); field.value = ''; drafts.sent(key); fit(); worded(); } catch (e) {
      note.textContent = errorText(e);
      if (guest) noLonger(e);
    } finally { sending = false; }
  };
  field.addEventListener('input', () => { drafts.set(key, field.value); fit(); worded(); });
  if (field.value) queueMicrotask(fit);
  field.addEventListener('keydown', (event) => {
    // As every box one writes in: Enter is a new line, Ctrl+Enter (⌘+Enter) sends.
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
    event.preventDefault();
    void send();
  });
  // Pressed, the keyboard stays where one writes, for the next.
  post.addEventListener('click', () => { void send(); field.focus({preventScroll: true}); });
  // The keyboard there as the board is drawn, nothing scrolled for it: come to from another page, the page is still
  // rising in from under the window (main.ts select), and the field reached for there pulled it up and away.
  if (b.member) queueMicrotask(() => { field.focus({preventScroll: true}); field.setSelectionRange(field.value.length, field.value.length); });
  form.append(field, post);
  worded();
  return form;
}

/**
 * One who came by an invitation: the name they will write as (shown with
 * "guest" beside it, never as one of its people's), then the box. Nothing
 * else is asked: the invitation is the proof.
 */
function guestIn(b: Shown, code: string, ways: DockWays): HTMLElement {
  const name = h('input', {class: 'line-in', maxlength: '32', placeholder: t('Display name'), 'aria-label': t('Display name'), autocomplete: 'nickname'}) as HTMLInputElement;
  const join = button(t('Post as guest'), 'small-button primary');
  const error = h('span', {class: 'error small', role: 'alert'});
  const box = h('div', {class: 'prompt server-say'}, h('span', {class: 'muted'}, t('You have been invited to post in #{board}.', {board: b.name})), name, join, error,
    h('span', {class: 'muted small'}, t('Your name will appear with a "guest" badge.')));
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
      error.textContent = errorText(e);
      // An invitation that opens nothing is let go: asking again with it cannot help.
      if (e instanceof RemoteError && e.status === 403) { servers.dropInvite(); name.disabled = join.disabled = true; }
    }
  };
  join.addEventListener('click', () => void go());
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void go(); } });
  queueMicrotask(() => name.focus({preventScroll: true}));
  return box;
}
