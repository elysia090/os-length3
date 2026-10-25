// One secret is given to the Remote (BETTER_AUTH_SECRET); each thing it
// keys gets a key of its own, derived from it with HKDF-SHA256 (RFC 5869)
// under a label that names the purpose and a version. No key is used for
// two purposes, so a key that is learned in one place opens nothing in
// another, and one purpose's key can move on (its label's version) while the
// others stay as they are (audit U1; OWASP ASVS 6.4.1, 6.4.2).
//
//   better-auth    sign-in: Better Auth's cookies, OAuth state, its own encryption
//   domain-proof   an Inbox domain's TXT proof (inbox.ts)
//   invite         what is kept of a guest's invitation and token (servers.ts)
//   off-code       what is kept of the five-letter code that turns a repo off (repos.ts)
//   mark           a look's tag, what the Remote answers without its database (mark.ts)
//
// Rotating the secret (README.md, Rotating secrets) changes every key at once:
// everyone signs in again, each custom domain's TXT record is given anew,
// invitations out and guest tokens stop opening their boards, and each
// account sets its off-code again.

import {hkdfSync} from 'node:crypto';

export type Purpose = 'better-auth' | 'domain-proof' | 'invite' | 'off-code' | 'mark';

/** Fixed, public: HKDF's salt only separates this derivation from any other of the same secret. */
const SALT = 'length3-remote';

/** The key for `purpose`, as 64 hex digits (256 bits). Never the secret itself, for any purpose. */
export function keyFor(secret: string, purpose: Purpose, version = 1): string {
  if (!secret) return '';
  const k = new Uint8Array(hkdfSync('sha256', secret, SALT, `length3/${purpose}/v${version}`, 32));
  return [...k].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256 of `text` under `key`, as hex. */
export async function hmacHex(key: string, text: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether two strings are the same, in time that does not depend on where they differ (only on their length). */
export function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
