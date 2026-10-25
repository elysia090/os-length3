import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {look, remoteAll} from '../../remote/lifecycle.ts';
import * as account from '../../remote/connection.ts';
import {freeOff} from '../../app/space.ts';
import {askFoot, SETTLE} from '../common.ts';
import {button, pressing} from './parts.ts';

// Turning a repo off, or discarding it: asked in its card first, with a passkey, the names and the code.

/** What is done to a repo from its card once it is asked: turned off (kept 30 days), or discarded for good. */
export type Deed = 'off' | 'discard';

/** How an ask ends: drawn again where it was asked (`done`) or once the browser did it (`ended`), and a passkey made on the way (`keyed`). */
export interface AskWays { done(): Promise<void>; ended(): Promise<void>; keyed(): void }

/**
 * What is asked for in the card before a repo is turned off or discarded: the deed's word, what will happen, and
 * the deed (`proven`: a passkey confirmed it was you a moment ago, setting the code, so it is not asked again).
 */
interface Ask { verb: string; what: string[]; act(name: string, typed: string, code: string, proven: boolean): Promise<unknown> }
const turningOff = (repo: string): Ask => ({
  verb: t('Turn off'),
  what: [t('Kept on the Remote for 30 days; turning it on brings it back at once.')],
  // The copy here stays until it is freed from the card (where Forge was).
  act: (who, typed, code, proven) => account.turnOff(repo, who, typed, code, proven),
});
/** Discarding, which takes it from the Remote now, for good; `here`, with the copy on this device. */
const discarding = (repo: string, here: boolean): Ask => ({
  verb: t('Discard'),
  what: [t('It goes from the Remote now, with its history, and cannot be brought back.'), ...(here ? [t('The copy here goes with it.')] : [])],
  // The copy here first: one holding what the Remote lacks is kept, and nothing is discarded.
  act: async (who, typed, code, proven) => { if (here) await freeOff(repo); await account.discard(repo, who, typed, code, proven); },
});

/** A passkey used this long ago still counts as just now: the Remote takes one for five minutes (service/app.ts `proven`). */
const PROOF = 4 * 60 * 1000;

/**
 * `kind` done to `repo`, pressed at `from` in its card `el` (`here`: with a copy on this device): asked first in the
 * card, on the web all of it, in the app as far as the browser, where the passkey is.
 */
export function askFirst(el: HTMLElement, from: Element, repo: string, kind: Deed, here: boolean, w: AskWays) {
  const ask = kind === 'off' ? turningOff(repo) : discarding(repo, here);
  if (account.deedsHere()) void confirm(el, from, repo, ask, w);
  else inTheBrowser(el, from, repo, kind, ask, w.ended);
}

/** Whether `kind` is done to `repo` as the Remote was last read: off, or gone. */
export const doneTo = (repo: string, kind: Deed): boolean => {
  const now = remoteAll().find((r) => r.name === repo);
  return !!(kind === 'off' ? now?.offAt : !now);
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
 * In the card: the names and the code, then a passkey; then the deed, on the
 * side it was pressed (`from`: the switch at the right, 廃棄 at the left), so
 * each step on to it comes under the pointer, and Not now on the other. With
 * no code yet, the card sets it first (making a passkey if the account has
 * none, then confirming with it) and goes straight on to the names.
 */
async function confirm(el: HTMLElement, from: Element, repo: string, ask: Ask, w: AskWays) {
  const cancel = button(t('Not now'), 'small-button');
  const c = inCard(el, from, repo, cancel, w.done);
  cancel.addEventListener('click', () => void w.done().then(() => backToSwitch(repo)));
  // The name checked is the account's, as its provider gave it; no page shows it, so the ask says it.
  const [code, me] = await Promise.all([account.offCode().catch(() => ({set: false})), account.me().catch(() => null)]);
  if (code.set) { names(c, ask, me?.name, 0); return; }
  // No code yet: it is set here, then the names are asked at once.
  const keys = await account.passkeys().catch(() => null);
  setCode(c, !!keys && !keys.length, w.keyed, () => names(c, ask, me?.name, Date.now()));
}

/** The names and the code (`me`, the account's name as the ask says it), then the deed; `provenAt`, a passkey's last use here. */
function names(c: InCard, ask: Ask, me: string | undefined, provenAt: number) {
  const error = h('p', {class: 'error', role: 'alert'});
  const who = field(t('Your name'));
  const which = field(t('The repo\'s name'));
  const five = field(t('Code'), {maxlength: '5', class: 'line-in mono'});
  const go = deedButton(ask.verb, c.from);
  settled(go, error, async () => {
    await ask.act(who.value, which.value, five.value, Date.now() - provenAt < PROOF);
    await look();
    await c.done();
    backToSwitch(c.repo);
  });
  show(c, ...lines(ask.what),
    me ? h('p', {class: 'muted small'}, t('To confirm, type {name}, {repo} and your code.', {name: me, repo: c.repo})) : null,
    who, which, five, error, c.foot(go));
  who.focus();
}

/** The code set first, with a passkey (a new one when the account has `none`); then `next`, the names. */
function setCode(c: InCard, none: boolean, keyed: () => void, next: () => void) {
  const error = h('p', {class: 'error', role: 'alert'});
  const five = field(t('New code'), {maxlength: '5', class: 'line-in mono'});
  const go = button(t('Set the code'), 'small-button primary');
  settled(go, error, async () => {
    if (!/^[A-Za-z0-9]{5}$/.test(five.value)) throw new Error(t('Five letters or digits.'));
    // Made once: pressed again after the confirming step was stopped, the passkey made is the one used.
    if (none) { await account.addPasskey(); none = false; keyed(); }
    await account.setOffCode(five.value);
    keyed();
    next();
  });
  show(c, h('p', {class: 'muted small'}, t('This asks for a five-letter code of your own.')),
    h('p', {class: 'muted small'}, none ? t('Set it here, with a new passkey on this device.') : t('Set it here, with your passkey.')),
    five, error, c.foot(go));
  five.focus();
}

/**
 * In the app, what a passkey confirms is the browser's (the app's window has none): the card says what will happen
 * as it does on the web, and Continue in the browser opens the Remote's page there at this repo's card, which asks
 * the rest. Waiting, the card says so; when the window comes back, what the Remote holds is read again, and the
 * cards are drawn as they are now once the deed is done there.
 */
function inTheBrowser(el: HTMLElement, from: Element, repo: string, kind: Deed, ask: Ask, done: () => Promise<void>) {
  const cancel = button(t('Not now'), 'small-button');
  const c = inCard(el, from, repo, cancel, done);
  const error = h('p', {class: 'error', role: 'alert'});
  const lead = h('p', {class: 'muted small'}, t('It asks for your passkey, which is in your browser: this repo\'s card opens there.'));
  const go = deedButton(t('Continue in the browser'), from);
  const came = async () => {
    if (!el.isConnected) { removeEventListener('focus', came); return; }
    await look().catch(() => {});
    if (!el.isConnected || !doneTo(repo, kind)) return;
    removeEventListener('focus', came);
    await done();
    backToSwitch(repo);
  };
  cancel.addEventListener('click', () => { removeEventListener('focus', came); void done().then(() => backToSwitch(repo)); });
  go.addEventListener('click', () => void pressing(go, error, async () => {
    await account.askBrowser(kind, repo);
    addEventListener('focus', came);
    lead.textContent = t('Open in your browser: confirm there, then come back. This card shows it.');
    go.textContent = t('Open the browser again');
  }));
  show(c, ...lines(ask.what), lead, error, c.foot(go));
  go.focus();
}
