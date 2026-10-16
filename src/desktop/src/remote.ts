// Who this device is on the Remote (service/), and how it talks to it.
//
//   web    はじめる: a blank account, and at once a passkey for it (a blank
//          one that gets no passkey is removed again). パスキーで入る on any
//          device after. 復旧コード when every passkey is gone: it opens the
//          account once, and a new passkey and a new code follow.
//   app    the browser does the passkey: the app shows a code, the browser
//          approves it on the Remote's page, and the app gets a session of
//          its own (core/src/remote.rs). l3 does the same.
//
// Every client holds a session token, sent as a bearer token; each device
// is a session that can be seen and ended from any other.

import {isNative} from './host.ts';
import {getState, loadState, setState} from './state.ts';

/** The Remote this build signs in to; '' is this page's own origin (development). */
export const REMOTE_URL: string = (() => {
  const v = (import.meta as {env?: Record<string, string>}).env?.VITE_LENGTH3_REMOTE;
  return v === undefined ? 'https://remote.length3.com' : v.replace(/\/$/, '');
})();

export interface Connection { url: string; token: string }

export const connection = (): Connection | null => {
  try { const c = JSON.parse(getState('remote') ?? 'null') as Connection | null; return c?.token ? c : null; } catch { return null; }
};

export class RemoteError extends Error {
  readonly status: number;
  readonly detail: Record<string, unknown>;
  constructor(status: number, message: string, detail: Record<string, unknown> = {}) { super(message); this.status = status; this.detail = detail; }
}

const OFFLINE = 'Remote に届きません';

/** A request to the Remote, as this device's session (or none). */
export async function api(path: string, init: RequestInit = {}, c: Connection | null = connection(), url = c?.url ?? REMOTE_URL): Promise<Response> {
  const headers = new Headers(init.headers);
  if (c) headers.set('Authorization', `Bearer ${c.token}`);
  if (typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  let r: Response;
  try { r = await fetch(url + path, {...init, headers, credentials: 'include'}); } catch { throw new RemoteError(0, OFFLINE); }
  if (r.status === 401 && c) throw new RemoteError(401, 'Remote がこの端末を知りません。もう一度入ってください');
  if (r.status >= 400 && r.status !== 404 && r.status !== 409) {
    const body = await r.json().catch(() => ({})) as {message?: string; error?: string};
    throw new RemoteError(r.status, body.message ?? body.error ?? `Remote: ${r.status}`);
  }
  return r;
}

export async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await api(path, init)).json() as Promise<T>;
}

const listeners = new Set<() => void>();
/** Hear when this device joins or leaves a Remote. */
export function onConnection(fn: () => void): () => void { listeners.add(fn); return () => listeners.delete(fn); }
const told = () => { for (const fn of [...listeners]) fn(); };
/** Say this device is in now (after the steps that follow recovery). */
export const joined = told;

async function keep(token: string, url = REMOTE_URL, tell = true) {
  await setState('remote', JSON.stringify({url, token}));
  if (tell) told();
}

/** The token a sign-in answered with (the bearer plugin's header). */
function tokenOf(r: Response): string {
  const t = r.headers.get('set-auth-token');
  if (!t) throw new RemoteError(r.status, '入れませんでした');
  return t;
}

// ---- passkeys (web) ----

const webauthn = () => import('@simplewebauthn/browser');

/** Add a passkey to the account this device is in. */
export async function addPasskey(name = deviceName()): Promise<void> {
  const {startRegistration} = await webauthn();
  const options = await json<Record<string, unknown>>(`/api/auth/passkey/generate-register-options?name=${encodeURIComponent(name)}`);
  // The browser and the authenticator make it; a cancel is not an error to explain.
  const response = await startRegistration({optionsJSON: options as never}).catch((e: unknown) => {
    throw new RemoteError(0, (e as {name?: string}).name === 'NotAllowedError' ? 'パスキーの作成をやめました' : `パスキーを作れませんでした（${String(e)}）`);
  });
  await json('/api/auth/passkey/verify-registration', {method: 'POST', body: JSON.stringify({response, name})});
}

/** はじめる: a new account, held by a passkey made now. */
export async function start(): Promise<void> {
  const r = await api('/api/auth/sign-in/anonymous', {method: 'POST', body: '{}'}, null);
  // Not in yet, as far as the pages go: only once the passkey holds it.
  await keep(tokenOf(r), REMOTE_URL, false);
  try { await addPasskey(); told(); } catch (e) {
    // Without a way back in, the account is not worth keeping.
    await api('/api/auth/delete-anonymous-user', {method: 'POST', body: '{}'}).catch(() => {});
    await forget();
    throw e;
  }
}

/** パスキーで入る. */
export async function signIn(): Promise<void> {
  const {startAuthentication} = await webauthn();
  const options = await (await api('/api/auth/passkey/generate-authenticate-options', {}, null)).json();
  const response = await startAuthentication({optionsJSON: options}).catch((e: unknown) => {
    throw new RemoteError(0, (e as {name?: string}).name === 'NotAllowedError' ? 'やめました' : `パスキーで入れませんでした（${String(e)}）`);
  });
  const r = await api('/api/auth/passkey/verify-authentication', {method: 'POST', body: JSON.stringify({response})}, null);
  await keep(tokenOf(r));
}

/** 復旧コードで入る: the code is spent; a new passkey and code should follow. */
export async function recover(code: string): Promise<void> {
  const r = await api('/api/auth/sign-in/recovery', {method: 'POST', body: JSON.stringify({code})}, null);
  // In, but the pages wait: a new passkey and a new code come first (joined()).
  await keep(tokenOf(r), REMOTE_URL, false);
}

export interface Passkey { id: string; name?: string | null; createdAt: string; deviceType?: string; backedUp?: boolean }
export const passkeys = () => json<Passkey[]>('/api/auth/passkey/list-user-passkeys');
export const removePasskey = (id: string) => json('/api/auth/passkey/delete-passkey', {method: 'POST', body: JSON.stringify({id})});

/** A new recovery code (the one before stops working); shown once. */
export const makeRecovery = async () => (await json<{code: string}>('/api/auth/recovery/create', {method: 'POST', body: '{}'})).code;
export const hasRecovery = async () => (await json<{hasCode: boolean}>('/api/auth/recovery/status')).hasCode;

// ---- devices: each a session ----

export interface Device { id: string; token: string; userAgent?: string | null; createdAt: string; updatedAt: string; current: boolean }

export async function devices(): Promise<Device[]> {
  // The bearer token is the session's token and its signature.
  const mine = connection()?.token.split('.')[0];
  const list = await json<Omit<Device, 'current'>[]>('/api/auth/list-sessions');
  return list.map((d) => ({...d, current: d.token === mine})).sort((a, b) => Number(b.current) - Number(a.current) || b.updatedAt.localeCompare(a.updatedAt));
}

/** End another device's session; it will have to be approved again. */
export const endDevice = (token: string) => json('/api/auth/revoke-session', {method: 'POST', body: JSON.stringify({token})});

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
  if (/^l3\b|ureq/i.test(u)) return 'l3 / アプリ';
  const os = /iPhone|iPad/.test(u) ? 'iOS' : /Android/.test(u) ? 'Android' : /Mac OS X/.test(u) ? 'macOS' : /Windows/.test(u) ? 'Windows' : /Linux/.test(u) ? 'Linux' : '';
  const browser = /Edg\//.test(u) ? 'Edge' : /Chrome\//.test(u) ? 'Chrome' : /Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : '';
  return [browser, os].filter(Boolean).join(' · ') || '端末';
}

function deviceName(): string {
  return deviceWord(navigator.userAgent);
}

// ---- the app: signing in through the browser ----

interface DeviceCode { device_code: string; user_code: string; verification_uri_complete: string; interval: number; expires_in: number }

async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const {invoke} = await import('@tauri-apps/api/core');
  return invoke<T>(command, args);
}

/** The app asks for a code and opens the browser on it; `wait` ends when it is approved. */
export async function appSignIn(): Promise<{code: string; url: string; wait: Promise<void>}> {
  const c = await invoke<DeviceCode>('remote_login_start');
  const wait = invoke<void>('remote_login_wait', {code: c}).then(async () => { await loadState(); told(); });
  return {code: c.user_code, url: c.verification_uri_complete, wait};
}

/** Leave the Remote on this device: its session ends; the repos here stay. */
export async function signOut(): Promise<void> {
  if (isNative) { await invoke('remote_logout'); await loadState(); told(); return; }
  await api('/api/auth/sign-out', {method: 'POST', body: '{}'}).catch(() => {});
  await forget();
}

async function forget() {
  await setState('remote', 'null');
  told();
}

/** Who is signed in here, as the Remote says. */
export async function me(): Promise<{id: string; name: string} | null> {
  if (!connection()) return null;
  const s = await json<{user: {id: string; name: string}} | null>('/api/auth/get-session');
  return s?.user ?? null;
}
