// The Agent's key in a browser, sealed by the person's passkey (core device/agent_key.rs Sealed). What a page keeps, a
// browser keeps in its profile's files as it was given: there a program reading those files (an infostealer's first
// look) or a copy of the disk finds it. Sealed, what is kept is the key encrypted (AES-256-GCM) under a key derived
// (HKDF-SHA-256) from what the passkey's PRF gives for a salt of its own (WebAuthn's prf extension: the authenticator
// computes it after verifying the person, every time), so it is opened only by the person, with that passkey, once a
// session; the key itself never goes to the core, nor to the Remote. What it does not keep out: a script on the page
// while the key is open (it is in the page as it asks), as nothing can. Where the browser or the passkey has no PRF,
// nothing is sealed, and Runtime says the key is kept as given.

import {t} from '../i18n/i18n.ts';

/** The key sealed: the passkey's id, the salt its PRF was asked with, the nonce, and what was sealed (base64url). */
export interface SealedKey { v: 1; credential: string; salt: string; iv: string; data: string }

const enc = new TextEncoder(), dec = new TextDecoder();
/** What the derived key is for, and what is sealed with it besides the key (so neither is taken for another). */
const INFO = enc.encode('length3 agent key'), WITH = enc.encode('length3 agent key v1');

const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const bytes = (b: BufferSource): Uint8Array => (b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));

/** The AES-GCM key the passkey's PRF output derives. */
async function derived(prf: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', prf as Uint8Array<ArrayBuffer>, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: INFO}, base, {name: 'AES-GCM', length: 256}, false, [usage]);
}

/**
 * The person's passkey for this site asked (that one, when `credential` names it): its id and what its PRF gives for
 * `salt`; null when it gives nothing (no PRF). Throws when the person calls it off.
 */
async function asked(salt: Uint8Array, credential?: Uint8Array): Promise<{id: ArrayBuffer; prf: Uint8Array} | null> {
  const got = await navigator.credentials.get({publicKey: {
    challenge: random(32), rpId: location.hostname, userVerification: 'required', timeout: 120_000,
    allowCredentials: credential ? [{type: 'public-key', id: credential as Uint8Array<ArrayBuffer>}] : [],
    extensions: {prf: {eval: {first: salt as Uint8Array<ArrayBuffer>}}},
  }}) as PublicKeyCredential | null;
  const first = got?.getClientExtensionResults().prf?.results?.first;
  return got && first ? {id: got.rawId, prf: bytes(first)} : null;
}

/** Whether this browser can seal with a passkey: it says its passkeys have PRF, or does not say. */
export async function canSeal(): Promise<boolean> {
  if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) return false;
  const says = await (PublicKeyCredential as {getClientCapabilities?: () => Promise<Record<string, boolean>>}).getClientCapabilities?.().catch(() => null);
  return says?.['extension:prf'] !== false;
}

/** `key` sealed by the passkey the person picks; null when it has no PRF. Throws when they call it off. */
export async function seal(key: string): Promise<SealedKey | null> {
  const salt = random(32);
  const got = await asked(salt);
  if (!got) return null;
  const iv = random(12);
  const data = await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: WITH}, await derived(got.prf, 'encrypt'), enc.encode(key));
  return {v: 1, credential: b64(got.id), salt: b64(salt), iv: b64(iv), data: b64(data)};
}

/** The key `s` seals, opened by the passkey that sealed it. Throws when the person calls it off, or it cannot. */
export async function unseal(s: SealedKey): Promise<string> {
  const got = await asked(unb64(s.salt), unb64(s.credential));
  if (!got) throw new Error(t('The passkey cannot open the sealed API key'));
  const key = await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64(s.iv), additionalData: WITH}, await derived(got.prf, 'decrypt'), unb64(s.data))
    .catch(() => { throw new Error(t('The passkey cannot open the sealed API key')); });
  return dec.decode(key);
}
