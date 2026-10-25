import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {look, remoteAll} from '../../remote/lifecycle.ts';
import * as account from '../../remote/connection.ts';
import {askFoot, SETTLE} from '../common.ts';
import {button, pressing} from './parts.ts';

// Turning a repo off, or discarding it: asked in its card first, with a passkey, the names and the code.

/**
 * What is asked for in the card before a repo is turned off or discarded: the deed's word, what will happen, and
 * the deed (`proven`: a passkey confirmed it was you a moment ago, setting the code, so it is not asked again).
 */
export interface Ask { verb: string; what: string[]; act(name: string, typed: string, code: string, proven: boolean): Promise<unknown> }
export const turningOff = (repo: string): Ask => ({
  verb: t('Turn off'),
  what: [t('Kept on the Remote for 30 days; turning it on brings it back at once.')],
  // The copy here stays until it is freed from the card (where Forge was).
  act: (who, typed, code, proven) => account.turnOff(repo, who, typed, code, proven),
});

/** A passkey used this long ago still counts as just now: the Remote takes one for five minutes (service/app.ts `proven`). */
const PROOF = 4 * 60 * 1000;

/**
 * In the card: the names and the code, then a passkey; then the deed, on the
 * side it was pressed (`from`: the switch at the right, 廃棄 at the left), so
 * each step on to it comes under the pointer, and Not now on the other. With
 * no code yet, the card sets it first (making a passkey if the account has
 * none, then confirming with it) and goes straight on to the names.
 */
export async function confirm(el: HTMLElement, from: Element, repo: string, ask: Ask, done: () => Promise<void>, keyed: () => void) {
  const answers = askFoot(from, el);
  // The card keeps its size while it asks, so the answers come where its own deeds were.
  el.style.minHeight = `${el.offsetHeight}px`;
  const cancel = button(t('Not now'), 'small-button');
  // The card drawn again, the keyboard goes back to its switch rather than to the page.
  const back = () => { if (document.activeElement === document.body) document.querySelector<HTMLElement>(`.card[data-repo="${CSS.escape(repo)}"] .power`)?.focus(); };
  cancel.addEventListener('click', () => void done().then(back));
  const field = (label: string, attrs: Record<string, string> = {}) => h('input', {class: 'line-in', 'aria-label': label, placeholder: label, autocomplete: 'off', spellcheck: 'false', ...attrs}) as HTMLInputElement;
  // A deed that comes under the pointer holds still a moment, so a double click does not answer it.
  const settled = (b: HTMLButtonElement, error: HTMLElement, f: () => Promise<void>) => {
    const shown = performance.now();
    b.addEventListener('click', () => { if (performance.now() - shown >= SETTLE) void pressing(b, error, f); });
  };
  // The name checked is the account's, as its provider gave it; no page shows it, so the ask says it.
  const [code, me] = await Promise.all([account.offCode().catch(() => ({set: false})), account.me().catch(() => null)]);
  let provenAt = 0;
  const names = () => {
    const error = h('p', {class: 'error', role: 'alert'});
    const who = field(t('Your name'));
    const which = field(t('The repo\'s name'));
    const five = field(t('Code'), {maxlength: '5', class: 'line-in mono'});
    // 廃棄 is asked for as it was pressed, ink when the pointer is on it.
    const go = button(ask.verb, from.classList.contains('discard') ? 'small-button discard' : 'small-button primary');
    settled(go, error, async () => {
      await ask.act(who.value, which.value, five.value, Date.now() - provenAt < PROOF);
      await look();
      await done();
      back();
    });
    el.replaceChildren(h('div', {class: 'off-ask', role: 'group', 'aria-label': repo}, h('span', {class: 'card-title'}, repo),
      ...ask.what.map((line) => h('p', {class: 'muted small'}, line)),
      me?.name ? h('p', {class: 'muted small'}, t('To confirm, type {name}, {repo} and your code.', {name: me.name, repo})) : null,
      who, which, five, error, answers(cancel, go)));
    who.focus();
  };
  if (code.set) { names(); return; }
  // No code yet: it is set here, then the names are asked at once.
  const keys = await account.passkeys().catch(() => null);
  let none = !!keys && !keys.length;
  const error = h('p', {class: 'error', role: 'alert'});
  const five = field(t('New code'), {maxlength: '5', class: 'line-in mono'});
  const go = button(t('Set the code'), 'small-button primary');
  settled(go, error, async () => {
    if (!/^[A-Za-z0-9]{5}$/.test(five.value)) throw new Error(t('Five letters or digits.'));
    // Made once: pressed again after the confirming step was stopped, the passkey made is the one used.
    if (none) { await account.addPasskey(); none = false; keyed(); }
    await account.setOffCode(five.value);
    keyed();
    provenAt = Date.now();
    names();
  });
  el.replaceChildren(h('div', {class: 'off-ask', role: 'group', 'aria-label': repo}, h('span', {class: 'card-title'}, repo),
    h('p', {class: 'muted small'}, t('This asks for a five-letter code of your own.')),
    h('p', {class: 'muted small'}, none ? t('Set it here, with a new passkey on this device.') : t('Set it here, with your passkey.')),
    five, error, answers(cancel, go)));
  five.focus();
}

/**
 * In the app, what a passkey confirms is the browser's (the app's window has none): the card says what will happen
 * as it does on the web, and Continue in the browser opens the Remote's page there at this repo's card, which asks
 * the rest. Waiting, the card says so; when the window comes back, what the Remote holds is read again, and the
 * cards are drawn as they are now once the deed is done there.
 */
export function inTheBrowser(el: HTMLElement, from: Element, repo: string, kind: 'off' | 'discard', ask: Ask, done: () => Promise<void>) {
  const answers = askFoot(from, el);
  el.style.minHeight = `${el.offsetHeight}px`;
  const error = h('p', {class: 'error', role: 'alert'});
  const lead = h('p', {class: 'muted small'}, t('It asks for your passkey, which is in your browser: this repo\'s card opens there.'));
  const cancel = button(t('Not now'), 'small-button');
  const go = button(t('Continue in the browser'), from.classList.contains('discard') ? 'small-button discard' : 'small-button primary');
  const back = () => { if (document.activeElement === document.body) document.querySelector<HTMLElement>(`.card[data-repo="${CSS.escape(repo)}"] .power`)?.focus(); };
  const came = async () => {
    if (!el.isConnected) { removeEventListener('focus', came); return; }
    await look().catch(() => {});
    const now = remoteAll().find((r) => r.name === repo);
    if (!el.isConnected || !(kind === 'off' ? now?.offAt : !now)) return;
    removeEventListener('focus', came);
    await done();
    back();
  };
  cancel.addEventListener('click', () => { removeEventListener('focus', came); void done().then(back); });
  go.addEventListener('click', () => void pressing(go, error, async () => {
    await account.askBrowser(kind, repo);
    addEventListener('focus', came);
    lead.textContent = t('Open in your browser: confirm there, then come back. This card shows it.');
    go.textContent = t('Open the browser again');
  }));
  el.replaceChildren(h('div', {class: 'off-ask', role: 'group', 'aria-label': repo}, h('span', {class: 'card-title'}, repo),
    ...ask.what.map((line) => h('p', {class: 'muted small'}, line)), lead, error, answers(cancel, go)));
  go.focus();
}
