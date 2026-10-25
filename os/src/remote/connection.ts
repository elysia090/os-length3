// Who this device is on the Remote (service/), and how it talks to it.
//
//   web    sign in with GitHub, Google or Apple; then a passkey for this device,
//          so the next sign-in needs no provider. Lost every passkey: continue
//          with the provider again.
//   app    the browser does the signing in: the app shows a code, the browser
//          approves it on the Remote's page, and the app gets a session of
//          its own (core/src/remote.rs). l3 does the same.
//
// Every client holds a session token, sent as a bearer token; each device
// is a session that can be seen and ended from any other.

import {core, isNative, native} from '../app/host.ts';
import {t} from '../i18n.ts';
import {getState, loadState} from '../home/state.ts';
import {setEnvironment} from '../core/client.ts';
import {webauthn} from './passkeys.ts';
import {jitter} from '../app/runs.ts';

import {DEFAULT_REMOTE} from '../app/policy.ts';
export {DEFAULT_REMOTE};
/** Its name before (0.4.x signed in by it): the same Worker answers it, and a device that kept it goes on by the one name. */
const FORMER_REMOTE = 'https://remote.length3.com';
/** A Remote's URL as it is used now (core/src/remote.rs current_url). */
export const currentURL = (url: string): string => {
  const u = url.replace(/\/$/, '');
  return u.toLowerCase() === FORMER_REMOTE ? DEFAULT_REMOTE : u;
};

/** The Remote this build signs in to; '' is this page's own origin (development). */
export const REMOTE_URL: string = (() => {
  const v = (import.meta as {env?: Record<string, string>}).env?.VITE_LENGTH3_REMOTE;
  return v === undefined ? DEFAULT_REMOTE : v.replace(/\/$/, '');
})();

// The core signs in to the same Remote as the page.
setEnvironment({LENGTH3_REMOTE: REMOTE_URL});

export interface Connection { url: string; token: string }

export const connection = (): Connection | null => {
  try {
    const c = JSON.parse(getState('remote') ?? 'null') as Connection | null;
    return c?.token ? {...c, url: currentURL(c.url ?? '')} : null;
  } catch { return null; }
};

/**
 * Why the Remote did not give what was asked, when it was not the Remote saying no: it was not reached (or not
 * in time), it is there but not taking requests (a gateway's 502, 503 or 504), or what answered is not its reply
 * (a page, as a host's fallback or a proxy gives, or words that do not read as its JSON).
 */
export type Trouble = 'unreached' | 'unavailable' | 'malformed';

export class RemoteError extends Error {
  readonly status: number;
  readonly detail: Record<string, unknown>;
  readonly trouble?: Trouble;
  constructor(status: number, message: string, detail: Record<string, unknown> = {}, trouble?: Trouble) {
    super(message); this.status = status; this.detail = detail; this.trouble = trouble;
  }
}

// Whether this device's Remote answered when last asked. While it does not,
// work goes on here and is sent once it answers; the rail says so (main.ts).
let away = false;
const reachers = new Set<() => void>();
export const remoteAway = (): boolean => away;
/** Hear when the Remote stops or starts answering. */
export function onReach(fn: () => void): () => void { reachers.add(fn); return () => reachers.delete(fn); }
function reached(answered: boolean) {
  if (away === !answered) return;
  away = !answered;
  awayAsks = 0; awayNext = 0;
  for (const fn of [...reachers]) fn();
}
let awayAsks = 0, awayNext = 0;
/**
 * Whether a look taken by itself (not one a person asked for) may ask the Remote now: always while it answers;
 * while it does not, less often each time (5 s, 10 s, … up to 5 minutes, give or take), so the pages and apps
 * open everywhere do not all ask a Remote that is coming back, at once and every few seconds.
 */
export function mayAsk(now = Date.now()): boolean {
  if (!away) return true;
  if (now < awayNext) return false;
  awayNext = now + jitter(Math.min(300_000, 5000 * 2 ** awayAsks++));
  return true;
}

/** How long the Remote said to wait before asking again (its `retryAfter`, seconds, beside Retry-After), in ms; undefined when it said nothing. */
export function retryAfter(e: unknown): number | undefined {
  const s = e instanceof RemoteError ? e.detail.retryAfter : undefined;
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s * 1000 : undefined;
}

/** How long a request to the Remote is waited on, unless the caller says (its own signal). */
const ASKED_WAIT = 30_000;
/** A request to the Remote, as this device's session (or none). */
/** Told after this page wrote something on its Remote (looks.ts: its next looks are asked afresh). */
const wrote = new Set<() => void>();
export const onWrite = (f: () => void) => { wrote.add(f); };

export async function api(path: string, init: RequestInit = {}, c: Connection | null = connection(), url = c?.url ?? REMOTE_URL): Promise<Response> {
  const headers = new Headers(init.headers);
  if (c) headers.set('Authorization', `Bearer ${c.token}`);
  if (typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  // Another Remote (a person's elsewhere) not answering says nothing of this one.
  const ours = url === (connection()?.url ?? REMOTE_URL);
  let r: Response;
  // Never waited on for good: a connection that went quiet half-open would hold every look after it (news, moved).
  const signal = init.signal ?? AbortSignal.timeout(ASKED_WAIT);
  try { r = await fetch(url + path, {...init, headers, signal, credentials: 'include'}); } catch (e) {
    if (ours) reached(false);
    const late = e instanceof DOMException && e.name === 'TimeoutError';
    throw new RemoteError(0, late ? t('The Remote did not answer in time') : t('The Remote cannot be reached'), {}, 'unreached');
  }
  // Something answered; it is the Remote only if its answer is the Remote's. A page is a host's or a proxy's, and a
  // gateway's 502, 503 or 504 says the Remote is not taking requests: either way it is away (the rail says so, and it is
  // asked again), never "offers nothing".
  const type = r.headers.get('content-type') ?? '';
  if (type.includes('text/html')) {
    if (ours) reached(false);
    throw new RemoteError(r.status, t('What answered is not the Remote ({status})', {status: r.status}), {}, 'malformed');
  }
  if (r.status === 502 || r.status === 503 || r.status === 504) {
    const body = await r.clone().json().catch(() => ({})) as {files?: boolean};
    // A Remote with no place for files says so itself, and is the Remote answering (below).
    if (body.files !== false) {
      if (ours) reached(false);
      throw new RemoteError(r.status, t('The Remote is not taking requests just now ({status})', {status: r.status}), {}, 'unavailable');
    }
  }
  if (ours) reached(true);
  // Written here: what it changed is read at the next look, not answered from a mark the write has not moved yet (the
  // Remote moves it once it has answered).
  if (ours && !['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase())) for (const f of wrote) f();
  if (r.status === 401 && c) {
    // The session was ended (from another device, or it ran out): this device is signed out, and nothing here is lost.
    if (ours && c.token === connection()?.token) void ended();
    throw new RemoteError(401, t('The Remote no longer knows this device. Sign in again.'));
  }
  if (r.status >= 400 && r.status !== 404 && r.status !== 409) {
    const body = await r.json().catch(() => ({})) as {message?: string; error?: string; files?: boolean};
    // A Remote with no place for files (service/bucket.ts): nothing is lost, the work waits here and is sent once it can be.
    if (r.status === 503 && body.files === false) throw new RemoteError(503, t('The Remote cannot hold files just now; your work stays on this device'), body);
    // The Remote says why in a short English sentence; it is shown in the person's language. What else it
    // says (the plan's rule, what is used) comes along for the place that asked.
    throw new RemoteError(r.status, t(body.message ?? body.error ?? `Remote: ${r.status}`), body as Record<string, unknown>);
  }
  return r;
}

export async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  return reading<T>(await api(path, init));
}

/** The Remote's JSON in `r`; words that do not read as it are not its answer (said so, never the parser's own error). */
export async function reading<T>(r: Response): Promise<T> {
  try { return await r.json() as T; } catch {
    reached(false);
    throw new RemoteError(r.status, t('The Remote\'s answer could not be read'), {}, 'malformed');
  }
}

const listeners = new Set<() => void>();
/** Hear when this device joins or leaves a Remote. */
export function onConnection(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
const told = () => { for (const fn of [...listeners]) fn(); };

async function keep(token: string, url = REMOTE_URL) {
  tryingAgain();
  // As the app keeps a session it signed in with: the core notes whose it is, and another account's copies stay theirs.
  await core('remote_connect', {url, token});
  await loadState(['remote', 'sync']);
  told();
}

/** The token a sign-in answered with (the bearer plugin's header). */
function tokenOf(r: Response): string {
  const token = r.headers.get('set-auth-token');
  if (!token) throw new RemoteError(r.status, t('Could not sign in'));
  return token;
}

// ---- signing in (web) ----

export type Provider = 'github' | 'google' | 'apple' | 'dev';
export const PROVIDER_NAME: Record<Provider, string> = {github: 'GitHub', google: 'Google', apple: 'Apple', dev: 'Development'};

/**
 * What this Remote offers to sign in with; `enter`, that it is entered by the link one was given and nothing else (a
 * Remote for research). `trouble`: it could not be asked (not reached, not in time, not taking requests, or what
 * answered was not its reply), in words, so a list that is empty for that is never taken for one it offers empty.
 */
export interface Ways { providers: Provider[]; passkey?: boolean; enter?: boolean; trouble?: string }
/** How long the first look at the Remote waits before it says it did not answer. */
const ABOUT_WAIT = 10_000;
export async function about(): Promise<Ways> {
  try {
    const w = await reading<Ways>(await api('/v1/about', {signal: AbortSignal.timeout(ABOUT_WAIT)}, null));
    if (!w || !Array.isArray(w.providers)) { reached(false); return {providers: [], trouble: t('The Remote\'s answer could not be read')}; }
    return w;
  } catch (e) { return {providers: [], trouble: e instanceof Error ? e.message : String(e)}; }
}

/** In by a link (…/#enter=KEY): the one account of a Remote for research. Why not, said once on the sign-in card. */
export async function enterWith(key: string): Promise<boolean> {
  try {
    const {token} = await (await api('/v1/enter', {method: 'POST', body: JSON.stringify({key})}, null)).json() as {token?: unknown};
    if (typeof token !== 'string') { signInTrouble = t('This link does not open this Remote'); return false; }
    await keep(token);
    return true;
  } catch (e) {
    signInTrouble = e instanceof Error ? e.message : String(e);
    return false;
  }
}

/**
 * Sign in with a provider: the page goes there and comes back to `back` (then claim()), signed in or not: called
 * off or refused at the provider, it is back here too (not on a page of the Remote's), and the card says so.
 */
export async function signInWith(provider: Provider, back = signedInURL()): Promise<void> {
  tryingAgain();
  // Which provider it was, so coming back without a session says it by its name.
  try { sessionStorage.setItem(SIGNING_WITH, provider); } catch { /* said without its name, then */ }
  const failed = new URL(back);
  failed.searchParams.delete('signed-in');
  failed.searchParams.set('sign-in-failed', '');
  const r = await api('/api/auth/sign-in/social', {method: 'POST', body: JSON.stringify({provider, callbackURL: back, errorCallbackURL: failed.toString()})}, null);
  const {url} = await r.json() as {url: string};
  location.assign(url);
}

/** Where a provider sends the page back: here, marked so the session is taken up. */
export function signedInURL(): string {
  const u = new URL(location.href);
  u.searchParams.set('signed-in', '');
  return u.toString();
}

/** Back from a provider: the Remote set its session cookie; keep the session's token here. */
export async function claim(): Promise<boolean> {
  try {
    const s = await (await api('/api/auth/get-session', {}, null)).json() as {session?: {token: string}} | null;
    if (!s?.session?.token) { signInTrouble = t('The provider did not sign you in. Try again.'); return false; }
    await keep(s.session.token);
    return true;
  } catch (e) {
    signInTrouble = e instanceof Error ? e.message : String(e);
    return false;
  }
}

/**
 * Back from a provider without a session (?sign-in-failed&error=…): why, by the error's code alone, in the app's own
 * words (the address's other words are anyone's to write, and are never shown); said on the card.
 */
export function signInFailed(code: string | null) {
  let tried: string | null = null;
  try { tried = sessionStorage.getItem(SIGNING_WITH); sessionStorage.removeItem(SIGNING_WITH); } catch { /* by no name, then */ }
  const name = tried && tried in PROVIDER_NAME ? PROVIDER_NAME[tried as Provider] : null;
  // Cancelled at the provider (its Cancel, or a refusal there): nothing was shared, and the way in is there again.
  signInTrouble = code === 'closed' ? t('This Remote takes no new accounts')
    : code === 'access_denied' ? (name ? t('Signing in with {name} was cancelled; nothing was shared.', {name}) : t('Signing in was cancelled at the provider; nothing was shared.'))
    : t('The provider did not sign you in. Try again.');
}
/** The provider a sign-in went to, kept for this tab until it comes back. */
const SIGNING_WITH = 'length3.signing-with';

/**
 * Why the last sign-in did not take, said on the sign-in card however often it is drawn (the page is drawn again
 * as what the Remote says comes in), until a sign-in is tried again or this device is in.
 */
let signInTrouble = '';
export const signInTroubleNow = (): string => signInTrouble;
/** A sign-in tried again: what the last one said is past. */
export const tryingAgain = () => { signInTrouble = ''; };

// ---- how this browser came in before: the first time a provider, after it a passkey ----

/** Whether this browser can make and use passkeys at all (WebAuthn); without it, providers are the way in. */
export const passkeysHere = (): boolean => typeof window !== 'undefined' && typeof (window as {PublicKeyCredential?: unknown}).PublicKeyCredential !== 'undefined';

const WAY = 'length3.way-in';
/** How this browser last came in: with a passkey (made here, or used here), or a provider; null, the first time. */
export function wayIn(): 'passkey' | 'provider' | null {
  try { const w = localStorage.getItem(WAY); return w === 'passkey' || w === 'provider' ? w : null; } catch { return null; }
}
/** Noted for the next sign-in: a passkey is never taken back to a provider (one that made a passkey is asked for it first). */
function cameIn(way: 'passkey' | 'provider') {
  try { if (way === 'passkey' || localStorage.getItem(WAY) !== 'passkey') localStorage.setItem(WAY, way); } catch { /* the first time's card, then */ }
}

const JUST = 'length3.just-signed-in';
/** Back from a provider, signed in: Remote's page offers a passkey for next time, once, in this tab. */
export function justSignedIn() {
  cameIn('provider');
  try { sessionStorage.setItem(JUST, '1'); } catch { /* the offer under the repos stays */ }
}
/** Whether this tab came in through a provider just now and has not had the passkey offer answered (made, or Later). */
export function justSignedInHere(): boolean {
  try { return sessionStorage.getItem(JUST) === '1'; } catch { return false; }
}
/** The offer answered (a passkey made, or put off), or there is one already: not offered again in this tab. */
export function passkeyOfferDone() {
  try { sessionStorage.removeItem(JUST); } catch { /* offered again, then */ }
}

/** Another provider for the same account (a second way back in). */
export async function link(provider: Provider): Promise<void> {
  const {url} = await json<{url: string}>('/api/auth/link-social', {method: 'POST', body: JSON.stringify({provider, callbackURL: location.href})});
  location.assign(url);
}

export interface Linked { id: string; providerId: string; accountId: string; createdAt: string }
export const linked = async () => (await json<Linked[]>('/api/auth/list-accounts')).filter((a) => a.providerId !== 'credential');
export const unlink = (providerId: string) => json('/api/auth/unlink-account', {method: 'POST', body: JSON.stringify({providerId})});

// ---- passkeys (web) ----

const cancelled = (e: unknown) => (e as {name?: string}).name === 'NotAllowedError';

/** Add a passkey for this device to the account it is signed in to. */
export async function addPasskey(name = deviceName()): Promise<void> {
  const {startRegistration} = await webauthn();
  const options = await json<Record<string, unknown>>(`/api/auth/passkey/generate-register-options?name=${encodeURIComponent(name)}`);
  const response = await startRegistration({optionsJSON: options as never}).catch((e: unknown) => {
    throw new RemoteError(0, cancelled(e) ? t('The passkey was not made.') : t('Could not make a passkey ({why}).', {why: String(e)}));
  });
  await json('/api/auth/passkey/verify-registration', {method: 'POST', body: JSON.stringify({response, name})});
  cameIn('passkey');
}

/** Sign in with a passkey (any of the account's, on this device or synced to it). */
export async function signIn(): Promise<void> {
  tryingAgain();
  const {startAuthentication} = await webauthn();
  const options = await (await api('/api/auth/passkey/generate-authenticate-options', {}, null)).json();
  const response = await startAuthentication({optionsJSON: options}).catch((e: unknown) => {
    throw new RemoteError(0, cancelled(e) ? t('Signing in was stopped.') : t('Could not sign in with a passkey ({why}).', {why: String(e)}));
  });
  const r = await api('/api/auth/passkey/verify-authentication', {method: 'POST', body: JSON.stringify({response})}, null);
  await keep(tokenOf(r));
  cameIn('passkey');
}

// ---- what only the browser does: a passkey's deeds, and a provider's ----

/**
 * What the app asks the browser to do, where the passkeys are (core account::ASKS): Remote's Sign-in (a passkey
 * added, a provider linked, the code set), or a repo turned off or discarded at its card.
 */
export type BrowserAsk = 'sign-in' | 'off' | 'discard';
/** Whether this page can make and use a passkey and come back from a provider: the browser's, never the app's window. */
export const deedsHere = (): boolean => !isNative;
/** The browser opened on the Remote's own app at `ask` (`repo`'s card for off and discard): the app's way to a passkey's deeds. */
export const askBrowser = (ask: BrowserAsk, repo?: string) => native<void>('app_open', {ask, ...(repo ? {repo} : {})});

const ASKED = 'length3.asked';
/** Opened by the app at an ask (…/?account=off&repo=NAME): held for this tab until Remote's page does it, a sign-in on the way included. */
export function holdAsk(ask: string | null, repo: string | null): BrowserAsk | null {
  if (ask !== 'sign-in' && ask !== 'off' && ask !== 'discard') return null;
  try { sessionStorage.setItem(ASKED, JSON.stringify({ask, repo})); } catch { /* asked of a page that cannot keep it: Remote's page all the same */ }
  return ask;
}
/** What the app asked of this tab, once: taken by the part that does it. */
export function takeAsk(): {ask: BrowserAsk; repo: string | null} | null {
  try {
    const held = sessionStorage.getItem(ASKED);
    sessionStorage.removeItem(ASKED);
    return held ? JSON.parse(held) as {ask: BrowserAsk; repo: string | null} : null;
  } catch { return null; }
}

// ---- turning a repo off: a passkey just now, the names, and the account's five-letter code ----

/** Whether the account has set the code that turning a repo off asks for. */
export const offCode = () => json<{set: boolean; setAt: number | null}>('/v1/off-code');

/** Set the code (five letters or digits); a passkey confirms it is you. */
export async function setOffCode(code: string): Promise<void> {
  await signIn();
  await json('/v1/off-code', {method: 'POST', body: JSON.stringify({code})});
}

/**
 * Turn `repo` off: kept 30 days on the Remote, back at once until then. `proven`: a passkey confirmed it a
 * moment ago (setting the code), which the Remote still takes; else one is asked for now.
 */
export async function turnOff(repo: string, name: string, typed: string, code: string, proven = false): Promise<{offAt: number; until: number}> {
  if (!proven) await signIn();
  const r = await api(`/v1/repos/${encodeURIComponent(repo)}/off`, {method: 'POST', body: JSON.stringify({name, repo: typed, code})});
  const body = await r.json() as {offAt?: number; until?: number; error?: string};
  if (!r.ok) throw new RemoteError(r.status, t(body.error ?? `Remote: ${r.status}`));
  return {offAt: body.offAt!, until: body.until!};
}

/** On again, as it was. */
export const turnOn = (repo: string) => json(`/v1/repos/${encodeURIComponent(repo)}/on`, {method: 'POST'});

/** Discard a repo turned off: gone from the Remote now, with its history, for good. Asked for as turning it off is. */
export async function discard(repo: string, name: string, typed: string, code: string, proven = false): Promise<void> {
  if (!proven) await signIn();
  const r = await api(`/v1/repos/${encodeURIComponent(repo)}/discard`, {method: 'POST', body: JSON.stringify({name, repo: typed, code})});
  if (!r.ok) throw new RemoteError(r.status, t(((await r.json()) as {error?: string}).error ?? `Remote: ${r.status}`));
}

export interface Passkey { id: string; name?: string | null; createdAt: string; deviceType?: string; backedUp?: boolean }
export const passkeys = () => json<Passkey[]>('/api/auth/passkey/list-user-passkeys');
export const removePasskey = (id: string) => json('/api/auth/passkey/delete-passkey', {method: 'POST', body: JSON.stringify({id})});

// ---- devices: each a session ----

export interface Device { id: string; token: string; userAgent?: string | null; createdAt: string; updatedAt: string; current: boolean }

export async function devices(): Promise<Device[]> {
  // The bearer token is the session's token and its signature.
  const mine = connection()?.token.split('.')[0];
  const list = await json<Omit<Device, 'current'>[]>('/api/auth/list-sessions');
  return list.map((d) => ({...d, current: d.token === mine})).sort((a, b) => Number(b.current) - Number(a.current) || b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * End another device's session (as `l3 remote devices rm N` does); it will have to sign in again. This
 * device is never ended from the list: it signs out from the person's menu, which forgets it here too.
 */
export async function endDevice(d: Pick<Device, 'token'>): Promise<void> {
  if (d.token === connection()?.token.split('.')[0]) throw new RemoteError(0, t('This device signs out from your menu at the foot of the rail.'));
  await json('/api/auth/revoke-session', {method: 'POST', body: JSON.stringify({token: d.token})});
}

/** A device asking to join (l3, the app): which one, before it is let in. */
export async function deviceAsking(userCode: string): Promise<{clientId: string; status: string}> {
  const r = await json<{client_id?: string; clientId?: string; status: string}>(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`);
  return {clientId: r.client_id ?? r.clientId ?? '', status: r.status};
}
export const approveDevice = (userCode: string) => json('/api/auth/device/approve', {method: 'POST', body: JSON.stringify({userCode})});
export const denyDevice = (userCode: string) => json('/api/auth/device/deny', {method: 'POST', body: JSON.stringify({userCode})});

/** What a session's user agent is, in a word. */
export function deviceWord(ua: string | null | undefined): string {
  const u = ua ?? '';
  if (/^l3\b|ureq/i.test(u)) return t('l3 / the app');
  const os = /iPhone|iPad/.test(u) ? 'iOS' : /Android/.test(u) ? 'Android' : /Mac OS X/.test(u) ? 'macOS' : /Windows/.test(u) ? 'Windows' : /Linux/.test(u) ? 'Linux' : '';
  const browser = /Edg\//.test(u) ? 'Edge' : /Chrome\//.test(u) ? 'Chrome' : /Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : '';
  return [browser, os].filter(Boolean).join(' · ') || t('A device');
}

function deviceName(): string {
  return deviceWord(navigator.userAgent);
}

// ---- the app: signing in through the browser ----

interface DeviceCode { device_code: string; user_code: string; verification_uri_complete: string; interval: number; expires_in: number }

let signingIn: Promise<{code: string; url: string; wait: Promise<void>}> | null = null;
/**
 * The app asks for a code and opens the browser on it; `wait` ends when it is approved. Asked again while one is
 * waited on, it is the same code: a second would poll the Remote beside the first, and neither can be called off.
 */
export function appSignIn(): Promise<{code: string; url: string; wait: Promise<void>}> {
  signingIn ??= (async () => {
    const c = await native<DeviceCode>('remote_login_start');
    const wait = core<void>('remote_login_wait', {code: c}).then(async () => { await loadState(); told(); });
    void wait.finally(() => { signingIn = null; }).catch(() => {});
    return {code: c.user_code, url: c.verification_uri_complete, wait};
  })().catch((e: unknown) => { signingIn = null; throw e; });
  return signingIn;
}

/** Leave the Remote on this device: its session ends; the repos here stay. */
export async function signOut(): Promise<void> {
  // What is not on the Remote yet is sent first; what cannot be sent keeps this device on it, and says why (core logout).
  await core('remote_logout');
  await loadState();
  told();
}

async function ended() {
  // Said on the sign-in card that comes next: why it is there.
  signInTrouble = t('The Remote no longer knows this device. Sign in again.');
  // The Remote already let this session go: nothing can be sent with it, and nothing here is let go.
  await core('remote_forget').catch(() => {});
  await loadState(['remote']);
  told();
}

/**
 * The account this device's session is of (its id), asked once a session:
 * what is agreed with the Remote is agreed with an account, and is not
 * taken for another's that signs in on the same device later.
 */
let account: {token: string; id: Promise<string | null>} | null = null;
export function accountId(): Promise<string | null> {
  const c = connection();
  if (!c) return Promise.resolve(null);
  if (account?.token !== c.token) {
    const token = c.token;
    const id = json<{user?: {id?: string}} | null>('/api/auth/get-session').then((s) => s?.user?.id ?? null);
    // Not answered (offline): asked again next time.
    id.catch(() => { if (account?.token === token) account = null; });
    account = {token, id};
  }
  return account.id;
}

/** Who is signed in here, as the Remote says. */
export async function me(): Promise<{id: string; name: string} | null> {
  if (!connection()) return null;
  const s = await json<{user: {id: string; name: string}} | null>('/api/auth/get-session');
  return s?.user ?? null;
}

/** The name the Remote knows the person by (what a commit, a start or a review says), asked once until it changes. */
let named: {token: string; name: Promise<string>} | null = null;
export function myName(): Promise<string> {
  const c = connection();
  if (!c) return Promise.resolve('');
  if (named?.token !== c.token) {
    const token = c.token;
    const name = me().then((m) => m?.name ?? '');
    name.catch(() => { if (named?.token === token) named = null; });
    named = {token, name};
  }
  return named.name;
}

/** One person, one name: the name written on Home's profile is the account's, and so what is done from here says it. */
export async function rename(name: string): Promise<void> {
  if (!connection() || name === await myName().catch(() => '')) return;
  await json('/api/auth/update-user', {method: 'POST', body: JSON.stringify({name})});
  named = null;
}
