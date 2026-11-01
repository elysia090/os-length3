import {h} from '../../ui/dom.ts';
import {isNative, native} from '../../app/host.ts';
import {t} from '../../i18n.ts';
import * as account from '../../remote/connection.ts';
import {errorText} from '../../app/errors.ts';
import {button, pressing} from './parts.ts';

// Signing in: one card where what the Remote holds would be, and the ways in under its title. Remote's page
// shows it signed out; Inbox, Server and the page a device's code opens show the same card in the same place.

/**
 * Signing in, the first thing a person meets: one card where the page's parts will be, at its left under the
 * header (an ink edge over paper, as the current issue card is), the ways in one under another; what signing in
 * opens comes in where it stood.
 */
export function signInPlace(title: string, ...body: Node[]): HTMLElement {
  return h('div', {class: 'sign-in-place'},
    h('section', {class: 'sign-in-card', 'aria-labelledby': 'sign-in-title'}, h('h2', {id: 'sign-in-title'}, title), ...body));
}

/**
 * Under the card's title, what signing in opens on this page (`what`), and that nothing else waits on it: what is here
 * works without it. Signed out is not a page of nothing to do.
 */
export function signInLead(what: string): HTMLElement[] {
  return [h('p', {class: 'muted small sign-in-what'}, what),
    h('p', {class: 'muted small sign-in-what'}, isNative ? t('All other features work offline; repos remain on this device.') : t('All other features work offline; repos remain in this browser.'))];
}

/**
 * The ways in, under the card's title. On the web, the first time is a provider and nothing else (GitHub,
 * Google or Apple, as this Remote offers them: none is shown that cannot be used); a passkey is made after it.
 * Once this browser made or used a passkey, the passkey is the way in, the providers under it for a passkey
 * lost (then a new one is made, after). In the app, the browser signs in: a code it shows, approved there, and the app comes
 * forward again; waiting, it can be opened again or called off, and a refusal or a code run out is said with
 * Try again. Each step is said as what it is: waiting for the browser, signed in, then connected (Remote's
 * page says that last, apart: being signed in is not the same as reaching the Remote). `done` runs once this
 * device is in; a provider leaves the page and comes back to `back`.
 */
export function signInBox(done: () => void, back?: string): HTMLElement {
  const error = h('p', {class: 'error', role: 'alert'});
  const box = h('div', {class: 'remote-join'});
  // Why the card is here, if a session ended or a provider did not sign in: once.
  error.textContent = account.signInTroubleNow();
  box.append(...(isNative ? byCode(done, error) : byProvider(box, done, back, error)), error);
  return box;
}

/** In the app: Sign in in the browser, then the code it is to approve there, until this device is in. */
function byCode(done: () => void, error: HTMLElement): Node[] {
  const go = button(t('Sign in via browser'), 'primary');
  const lead = h('p', {class: 'muted small sign-in-lead'}, t('Opening browser to complete sign-in.'));
  const waiting = h('div', {class: 'remote-join sign-in-waiting', hidden: '', role: 'status'});
  let waited = 0;
  /** The card as it was before the browser was asked: its lead and Sign in in the browser, no code. */
  const asBefore = () => { waiting.hidden = true; go.hidden = false; lead.hidden = false; };
  go.addEventListener('click', () => void pressing(go, error, async () => {
    const mine = ++waited;
    const s = await account.appSignIn();
    // Called off here: the card is as it was. The code still waits in the browser until it runs out; approved
    // there after all, this device is signed in then, as asked.
    const stop = () => { waited++; asBefore(); go.focus(); };
    waiting.hidden = false;
    waiting.replaceChildren(...codeShown(s, error, stop));
    go.hidden = true;
    lead.hidden = true;
    try {
      await s.wait;
    } catch (e) {
      if (mine !== waited) return;
      asBefore();
      go.textContent = t('Try again');
      throw e;
    }
    waiting.replaceChildren(h('p', {class: 'sign-in-step done'}, t('Signed in')));
    // Back from the browser: this window forward, where the person began.
    void native('window_forward').catch(() => {});
    done();
  }));
  return [lead, h('div', {class: 'row sign-in-row'}, go), waiting];
}

/** The code the browser is to approve (`s`), with Cancel (`stop`) and Open the browser again under it. */
function codeShown(s: {code: string; url: string}, error: HTMLElement, stop: () => void): Node[] {
  const again = button(t('Reopen browser'), 'small-button'), cancel = button(t('Cancel'), 'small-button');
  again.addEventListener('click', () => void native('remote_login_reopen').catch((e: unknown) => { error.textContent = errorText(e); }));
  cancel.addEventListener('click', stop);
  return [h('p', {class: 'sign-in-step'}, t('Approve this code in the browser')),
    h('p', {class: 'device-code mono', title: s.url}, s.code),
    h('div', {class: 'row sign-in-row'}, cancel, again)];
}

/**
 * On the web: the providers this Remote offers (`back`, where one comes back to) and, returning, the passkey over
 * them; asked again while the Remote is away, until it answers (`box` on screen).
 */
function byProvider(box: HTMLElement, done: () => void, back: string | undefined, error: HTMLElement): Node[] {
  const returning = account.wayIn() === 'passkey' && account.passkeysHere();
  // The buttons say it: no words around them (the card is narrow, and each is one way in).
  const providers = h('div', {class: 'row sign-in-row'});
  const passkey = button(t('Sign in with passkey'), 'primary');
  const ways = () => void account.about().then((w) => offered(w, providers, passkey, {returning, back, error, again: ways}));
  ways();
  const stop = account.onReach(() => { if (!box.isConnected) { stop(); return; } if (!account.remoteAway()) ways(); });
  passkey.addEventListener('click', () => void pressing(passkey, error, async () => { await account.signIn(); done(); }));
  // Returning, the passkey first and the providers under it; the first time, the providers alone.
  return returning ? [h('div', {class: 'row sign-in-row'}, passkey), providers] : [providers];
}

/**
 * The ways in this Remote offers (`w`), in `providers`: a button each, the first the primary unless the passkey is
 * (`returning`). None offered, why: it could not be asked (with Try again, `again`), or it is entered by a link.
 */
function offered(w: account.Ways, providers: HTMLElement, passkey: HTMLElement,
  o: {returning: boolean; back: string | undefined; error: HTMLElement; again: () => void}) {
  // Entered by a link alone: no provider, no passkey, and the card says where the way in is.
  if (w.enter) passkey.hidden = true;
  providers.replaceChildren(...w.providers.map((p, i) => {
    const b = button(t('Continue with {name}', {name: account.PROVIDER_NAME[p]}), i === 0 && !o.returning ? 'primary' : '');
    b.addEventListener('click', () => void pressing(b, o.error, () => account.signInWith(p, o.back)));
    return b;
  }));
  if (w.providers.length) return;
  // No ways because it could not be asked is not the same as none offered: why, and Try again (it is also asked
  // again by itself while it is away, and the ways come once it answers).
  if (w.trouble) {
    const again = button(t('Try again'), 'small-button');
    again.addEventListener('click', () => { again.disabled = true; o.again(); });
    providers.replaceChildren(h('span', {class: 'muted', role: 'status'}, w.trouble), again);
    return;
  }
  providers.replaceChildren(h('span', {class: 'muted'}, w.enter ? t('Access this Remote using your assigned invite link.') : t('This Remote does not support sign-in yet.')));
}
