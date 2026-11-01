import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {flush, look, remoteAll} from '../../remote/lifecycle.ts';
import * as account from '../../remote/connection.ts';
import {freeOff} from '../../app/space.ts';
import {askFoot, SETTLE} from '../common.ts';
import {errorText} from '../../app/errors.ts';
import {button, pressing} from './parts.ts';

// Turning a repo off, or discarding it: asked in its card first, its name written out, then a passkey (as GitHub asks
// for a repository's name before it is deleted). Deleting it from a list's gear (repo-gear.ts) is asked the same, in
// the gear's list: it is turned off, and its copy here goes.

/**
 * What is done to a repo from its card once it is asked: turned off (kept 30 days), or discarded for good; or, from a
 * list's gear, deleted: turned off, and what is here of it gone (`after`).
 */
export type Deed = 'off' | 'discard' | 'delete';

/** How an ask ends: drawn again where it was asked (`done`) or once the browser did it (`ended`), and a passkey made on the way (`keyed`). */
export interface AskWays { done(): Promise<void>; ended(): Promise<void>; keyed(): void }

/** What is asked for in the card before a repo is turned off or discarded: the deed's word, what will happen, and the deed (`typed`, its name as written). */
interface Ask { verb: string; what: string[]; act(typed: string): Promise<unknown> }
const turningOff = (repo: string): Ask => ({
  verb: t('Disable'),
  what: [t('Retained on Remote for 30 days; re-enabling restores it immediately.')],
  // The copy here stays until it is freed from the card (where Forge was).
  act: (typed) => account.turnOff(repo, typed),
});
/** Discarding, which takes it from the Remote now, for good; `here`, with the copy on this device. */
const discarding = (repo: string, here: boolean): Ask => ({
  verb: t('Delete permanently'),
  what: [t('Permanently deleted from Remote with full history. Cannot be undone.'), ...(here ? [t('Local copy will also be deleted.')] : [])],
  // The copy here first: one holding what the Remote lacks is kept, and nothing is discarded.
  act: async (typed) => { if (here) await freeOff(repo); await account.discard(repo, typed); },
});

/**
 * Deleting, from a list's gear: what is not on the Remote yet is sent, then it is turned off (kept 30 days, so a hand
 * that slipped can bring it back), then `after` takes what is here of it.
 */
const deleting = (repo: string, after: () => Promise<void>): Ask => ({
  verb: t('Delete'),
  what: [t('Removes from device and Remote (held 30 days on Remote before final deletion).')],
  act: async (typed) => { await flush(); await account.turnOff(repo, typed); await after(); },
});

/**
 * `kind` done to `repo`, pressed at `from` in its card `el` (`here`: with a copy on this device): asked first in the
 * card, on the web all of it, in the app as far as the browser, where the passkey is. Deleting, `after` takes what is
 * here of it once the Remote has turned it off.
 */
export function askFirst(el: HTMLElement, from: Element, repo: string, kind: Deed, here: boolean, w: AskWays, after: () => Promise<void> = async () => {}) {
  const ask = kind === 'off' ? turningOff(repo) : kind === 'discard' ? discarding(repo, here) : deleting(repo, after);
  if (account.deedsHere()) void confirm(el, from, repo, ask, w);
  else inTheBrowser(el, from, repo, kind, ask, w.ended, after);
}

/** Whether `kind` is done to `repo` as the Remote was last read: off (deleted from a list is turned off there), or gone. */
export const doneTo = (repo: string, kind: Deed): boolean => {
  const now = remoteAll().find((r) => r.name === repo);
  return !!(kind === 'discard' ? !now : now?.offAt);
};

/** An ask under way in a card: the card, its repo, its foot (Not now, and the deed on the side `from` was), and its end. */
interface InCard { el: HTMLElement; repo: string; from: Element; foot(go: HTMLButtonElement): HTMLElement; done(): Promise<void> }

/** `el` about to ask: its foot measured before the card gives way, and its size kept, so the answers come where its own deeds were. */
function inCard(el: HTMLElement, from: Element, repo: string, cancel: HTMLButtonElement, done: () => Promise<void>): InCard {
  const foot = askFoot(from, el);
  el.style.minHeight = `${el.offsetHeight}px`;
  return {el, repo, from, foot: (go) => foot(cancel, go), done};
}

/** The card given to the ask: the repo's name, and under it what is asked. */
function show(c: InCard, ...body: (Node | null)[]) {
  c.el.replaceChildren(h('div', {class: 'off-ask', role: 'group', 'aria-label': c.repo}, h('span', {class: 'card-title'}, c.repo), ...body));
}

const lines = (what: string[]) => what.map((line) => h('p', {class: 'muted small'}, line));

const field = (label: string, attrs: Record<string, string> = {}) => h('input', {class: 'line-in', 'aria-label': label, placeholder: label, autocomplete: 'off', spellcheck: 'false', ...attrs}) as HTMLInputElement;

/** The deed, as it was pressed: 廃棄 asked for as 廃棄 (ink when the pointer is on it), the switch's as the primary. */
const deedButton = (word: string, from: Element) => button(word, from.classList.contains('discard') ? 'small-button discard' : 'small-button primary');

/** The card drawn again, the keyboard goes back to its switch rather than to the page. */
const backToSwitch = (repo: string) => {
  if (document.activeElement === document.body) document.querySelector<HTMLElement>(`.card[data-repo="${CSS.escape(repo)}"] .power`)?.focus();
};

/** A deed that comes under the pointer holds still a moment, so a double click does not answer it. */
function settled(b: HTMLButtonElement, error: HTMLElement, f: () => Promise<void>) {
  const shown = performance.now();
  b.addEventListener('click', () => { if (performance.now() - shown >= SETTLE) void pressing(b, error, f); });
}

/**
 * In the card: the repo's name written out, then a passkey; then the deed, on the side it was pressed (`from`: the
 * switch at the right, 廃棄 at the left), so each step on to it comes under the pointer, and Not now on the other. An
 * account with no passkey yet makes one there and then (with it, nothing else is ever asked of them to turn off).
 */
async function confirm(el: HTMLElement, from: Element, repo: string, ask: Ask, w: AskWays) {
  const cancel = button(t('Cancel'), 'small-button');
  const c = inCard(el, from, repo, cancel, w.done);
  cancel.addEventListener('click', () => void w.done().then(() => backToSwitch(repo)));
  let none = ((await account.passkeys().catch(() => null)) ?? [{}]).length === 0;
  const error = h('p', {class: 'error', role: 'alert'});
  const which = field(t('Repo name'), {class: 'line-in mono'});
  const go = deedButton(ask.verb, c.from);
  settled(go, error, async () => {
    if (which.value !== repo) { which.focus(); throw new Error(t('Enter "{repo}" exactly as shown.', {repo})); }
    // Made once: pressed again after the passkey step was stopped, the passkey made is the one used.
    if (none) { await account.addPasskey(); none = false; w.keyed(); }
    await ask.act(which.value);
    await look();
    await c.done();
    backToSwitch(c.repo);
  });
  which.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) go.click(); });
  show(c, ...lines(ask.what), h('p', {class: 'muted small'}, t('To confirm, enter "{repo}".', {repo})), which, error, c.foot(go));
  which.focus();
}

/**
 * In the app, what a passkey confirms is the browser's (the app's window has none): the card says what will happen
 * as it does on the web, and Continue in the browser opens the Remote's page there at this repo's card, which asks
 * the rest. Waiting, the card says so; when the window comes back, what the Remote holds is read again, and the
 * cards are drawn as they are now once the deed is done there (deleted from a list, `after` first: what is here goes).
 */
function inTheBrowser(el: HTMLElement, from: Element, repo: string, kind: Deed, ask: Ask, done: () => Promise<void>, after: () => Promise<void>) {
  const cancel = button(t('Cancel'), 'small-button');
  const c = inCard(el, from, repo, cancel, done);
  const error = h('p', {class: 'error', role: 'alert'});
  const lead = h('p', {class: 'muted small'}, t('Requires passkey authentication via browser; opening repo settings card there.'));
  const go = deedButton(t('Continue in browser'), from);
  const came = async () => {
    if (!el.isConnected) { removeEventListener('focus', came); return; }
    await look().catch(() => {});
    if (!el.isConnected || !doneTo(repo, kind)) return;
    removeEventListener('focus', came);
    if (kind === 'delete') await after().catch((e: unknown) => { error.textContent = errorText(e); });
    await done();
    backToSwitch(repo);
  };
  cancel.addEventListener('click', () => { removeEventListener('focus', came); void done().then(() => backToSwitch(repo)); });
  go.addEventListener('click', () => void pressing(go, error, async () => {
    // Deleted from a list, it is turned off there; what is here goes once the window comes back to it done.
    await account.askBrowser(kind === 'delete' ? 'off' : kind, repo);
    addEventListener('focus', came);
    lead.textContent = t('Opened in browser: confirm there and return. Status will update here.');
    go.textContent = t('Reopen browser');
  }));
  show(c, ...lines(ask.what), lead, error, c.foot(go));
  go.focus();
}
