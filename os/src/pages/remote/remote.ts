import {ago, bytes, h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import * as account from '../../remote/connection.ts';
import {store} from '../../repos/repos.ts';
import {pageHead, parts, type Parts} from '../common.ts';
import type {Context} from '../context.ts';
import {signInBox, signInLead, signInPlace} from './sign-in.ts';
import {repoSection} from './repos.ts';
import {passkeyNext, passkeyOffer} from './passkey-offers.ts';
import {signInBody} from './sign-in-part.ts';
import {deviceSection} from './devices.ts';
import {planSection} from './plan.ts';

// Remote: where one's repos are kept, and who this device is there.
//
// Not signed in: one sentence on what it means, and the ways in. A browser
// signs in with GitHub, Google or Apple, or with a passkey it already has; the app
// and l3 show a code that a browser approves.
//
// Signed in: the repos, here and on the Remote only, each with where it
// stands; then what keeps the account: passkeys, the providers it can sign
// in with, the devices.

/** Who this device is on the Remote, and whether the Remote answers: two things, said apart. */
function standing(): HTMLElement {
  const who = h('span', {class: 'standing-who'});
  const reach = h('span', {class: 'standing-reach'});
  const line = h('p', {class: 'standing muted small', role: 'status'}, who, reach);
  // A Remote on the page's own origin (the web app's) is named by it: its URL is ''.
  const host = (() => { try { return new URL(account.connection()?.url || location.origin).host; } catch { return location.host; } })();
  void account.me().then((u) => { who.textContent = u?.name ? t('Signed in as {name}', {name: u.name}) : t('Signed in'); }, () => { who.textContent = t('Signed in'); });
  const show = () => {
    const away = account.remoteAway();
    reach.textContent = away ? t('{host} cannot be reached: what changes here is sent once it can', {host}) : t('Connected to {host}', {host});
    reach.classList.toggle('away', away);
  };
  show();
  const stop = account.onReach(() => { if (!line.isConnected) { stop(); return; } show(); });
  return line;
}

/**
 * Signed out, under the way in: what it is for. This device's repos stand where the Remote's will, faint, each
 * saying it is only here; signed in, the same cards stand there whole.
 */
function waiting(): HTMLElement {
  const grid = h('div', {class: 'grid repo-grid waiting'});
  // In the Remote's own order (by name), so each card is found again where it stood once signed in.
  void store.list().then((repos) => grid.replaceChildren(...[...repos].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((r) => h('div', {class: 'card ghost'},
    h('span', {class: 'card-title'}, r.name),
    h('span', {class: 'muted'}, `${bytes(r.bytes)} · ${t('Changed {when}', {when: ago(r.modified)})}`),
    h('span', {class: 'muted'}, t('Only on this device'))))), () => {});
  return grid;
}
export function remote(ctx: Context): Node[] {
  const holder = h('div', {});
  let shown: string | null = null;
  const paint = () => {
    const c = account.connection();
    const now = c ? 'in' : '';
    if (now === shown) return;
    shown = now;
    if (!c) holder.replaceChildren(signInPlace(t('Sign in'), ...signInLead(t('Signed in, your repos are kept in step across your devices, and shown to whom you choose.')), signInBox(() => paint())), waiting());
    else signedIn(ctx, holder, () => { shown = null; paint(); });
  };
  paint();
  const stop = account.onConnection(() => { if (!holder.isConnected) { stop(); return; } paint(); });
  return [pageHead('remote'), holder];
}

type Part = 'repos' | 'sign-in' | 'devices' | 'plan';

/**
 * Signed in, in `holder`: the part bar, who this device is and whether the Remote answers, then the part chosen.
 * `again` draws it all anew (a passkey added from the offer under the repos, shown under Sign-in at once).
 */
function signedIn(ctx: Context, holder: HTMLElement, again: () => void) {
  // One part at a time: the repos it keeps, how this account signs in, the devices in it.
  const page = parts<Part>('remote', [
    {id: 'repos', label: t('Repos')}, {id: 'sign-in', label: t('Sign-in')}, {id: 'devices', label: t('Devices')}, {id: 'plan', label: t('Plan')}]);
  planPart(page, holder);
  // Under the repos (it is what lets one be turned off); a passkey added from it shows under Sign-in at once.
  // It waits for the repos to be drawn (or a few seconds, if they cannot be), so it lands under them once.
  let listed = () => {};
  const drawn = new Promise<void>((r) => { listed = r; setTimeout(r, 3000); });
  const offer = passkeyOffer(again, drawn);
  const stale = signInPart(page);
  // The code (and a passkey) set while a repo is turned off: the offer has done its work, and Sign-in reads them again when shown.
  const keyed = () => { stale(); offer.hidden = true; };
  page.panel('repos').append(repoSection(ctx, (n) => { page.count('repos', n); listed(); }, keyed, () => page.show('plan')));
  page.panel('devices').append(deviceSection((n) => page.count('devices', n)));
  // Just back from a provider: a passkey for next time, offered once, above everything.
  // The offer under the repos waits while this one is up (one offer at a time), and comes back if it is put off.
  const next = account.justSignedInHere() ? passkeyNext(keyed, () => offer.classList.remove('held')) : null;
  if (next) offer.classList.add('held');
  holder.replaceChildren(
    h('div', {class: 'part-bar'}, page.switch),
    standing(),
    page.panel('repos'), page.panel('sign-in'), page.panel('devices'), page.panel('plan'));
  // The passkey offer belongs to the repos it lets be turned off: under them, never under another part; the one
  // just after a provider's sign-in, at their top.
  page.panel('repos').append(offer);
  if (next) page.panel('repos').prepend(next);
}

/**
 * The plan is the Remote's to say: shown once it says there is one, read again whenever its part is shown
 * or the window comes back (from Checkout or the portal, in another tab or the browser).
 */
function planPart(page: Parts<Part>, holder: HTMLElement) {
  const plan = planSection((on) => page.offer('plan', on));
  page.panel('plan').append(plan.el);
  void plan.paint();
  page.onShow((k) => { if (k === 'plan') void plan.paint(); });
  // Come back to (the window focused again: the browser in front of it is not its being hidden).
  const back = () => {
    if (!holder.isConnected) { document.removeEventListener('visibilitychange', back); removeEventListener('focus', back); return; }
    if (!document.hidden) void plan.paint();
  };
  document.addEventListener('visibilitychange', back);
  addEventListener('focus', back);
}

/**
 * Sign-in, as this Remote is entered; read again the next time it is shown once the function returned is called
 * (a passkey or the code made from a repo's card meanwhile).
 */
function signInPart(page: Parts<Part>): () => void {
  const fill = () => void account.about().then(({enter}) => page.panel('sign-in').replaceChildren(...signInBody(enter)));
  fill();
  let stale = false;
  page.onShow((k) => { if (k === 'sign-in' && stale) { stale = false; fill(); } });
  return () => { stale = true; };
}
