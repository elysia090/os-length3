// Who someone is, on the Remote: Better Auth, with passkeys as the way in.
//
//   start      a blank account is made (anonymous), and a passkey is added
//              to it at once; if that does not happen, the blank one goes
//   sign in    a passkey (discoverable: no name or address to type)
//   recover    the recovery code (recovery.ts), or GitHub if it was linked
//   app, l3    device authorization: the app shows a code, it is approved in
//              a browser with a passkey, and the device gets its own session
//
// Every client holds a session token (the bearer plugin) rather than a
// cookie, so the web app, the desktop app and l3 work the same way and a
// session can be seen and ended from any of them.

import {passkey} from '@better-auth/passkey';
import {betterAuth} from 'better-auth';
import {drizzleAdapter} from 'better-auth/adapters/drizzle';
import {anonymous, bearer, deviceAuthorization} from 'better-auth/plugins';
import {recovery} from './recovery.ts';
import * as schema from './schema.ts';

/** The desktop app and l3, the only clients that may ask for a device code. */
export const DEVICE_CLIENTS = ['length3-app', 'l3'] as const;

export interface AuthConfig {
  // Drizzle database of any Postgres driver (Neon in production, PGlite in tests).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  secret: string;
  /** Where this service is, e.g. https://remote.length3.com. */
  baseURL: string;
  /** The web app's origin, where passkeys are made and used (and devices approved). */
  appOrigin: string;
  /** Other pages that may call (the desktop app's webview, local development). */
  origins?: string[];
  github?: {clientId: string; clientSecret: string};
  /** Off only in tests, where every request comes from the same address. */
  rateLimit?: boolean;
}

export function createAuth(c: AuthConfig) {
  const rpID = new URL(c.appOrigin).hostname;
  return betterAuth({
    appName: 'Length³ OS',
    baseURL: c.baseURL,
    secret: c.secret,
    database: drizzleAdapter(c.db, {provider: 'pg', schema}),
    trustedOrigins: [c.appOrigin, ...(c.origins ?? [])],
    // Nobody signs in with a password here.
    emailAndPassword: {enabled: false},
    socialProviders: c.github ? {github: {clientId: c.github.clientId, clientSecret: c.github.clientSecret}} : {},
    account: {accountLinking: {enabled: true, trustedProviders: ['github']}},
    session: {expiresIn: 60 * 60 * 24 * 60, updateAge: 60 * 60 * 24},
    rateLimit: {enabled: c.rateLimit ?? true, window: 60, max: 120},
    plugins: [
      anonymous({emailDomainName: 'users.length3.invalid', generateName: () => ''}),
      passkey({
        rpID,
        rpName: 'Length³ OS',
        origin: c.appOrigin,
        authenticatorSelection: {residentKey: 'required', userVerification: 'preferred'},
      }),
      recovery(),
      bearer(),
      deviceAuthorization({
        verificationUri: `${c.appOrigin}/?device`,
        validateClient: (id: string) => (DEVICE_CLIENTS as readonly string[]).includes(id),
        expiresIn: '10m',
        interval: '2s',
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
