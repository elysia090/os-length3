// Who someone is, on the Remote: Better Auth, the ordinary way.
//
//   sign in   with GitHub, Google or Apple (OAuth): the account is that identity
//   then      a passkey, added from the first session, so later sign-ins
//             need no provider (discoverable: nothing to type)
//   recover   sign in with the provider again, and add a passkey there
//   app, l3   device authorization: the app shows a code, a browser where
//             the person is signed in approves it, and the device gets a
//             session of its own
//
// There are no blank accounts: every account is held by a provider's
// identity, which is also what keeps the Remote from being anyone's free,
// anonymous store or relay (app.ts sets the limits).
//
// Clients hold a session token (the bearer plugin): the web app reads its
// own once the provider sends it back, the app and l3 get theirs from the
// device flow, so a session can be seen and ended from any of them.

import {passkey} from '@better-auth/passkey';
import {betterAuth} from 'better-auth';
import {createAuthMiddleware} from 'better-auth/api';
import {drizzleAdapter} from 'better-auth/adapters/drizzle';
import {bearer, deviceAuthorization, genericOAuth} from 'better-auth/plugins';
import * as schema from './schema.ts';

/** The desktop app and l3, the only clients that may ask for a device code. */
export const DEVICE_CLIENTS = ['length3-app', 'l3'] as const;

export interface Provider { clientId: string; clientSecret: string }

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
  github?: Provider;
  google?: Provider;
  /** Sign in with Apple: its service id, and the client secret (a JWT signed with the team's key). */
  apple?: Provider;
  /** A stand-in provider on this service itself (devoauth.ts): development and tests only. */
  dev?: boolean;
  /** Off only in tests, where every request comes from the same address. */
  rateLimit?: boolean;
}

/** Which providers a Remote offers, in the order its sign-in shows them. */
export const providers = (c: Pick<AuthConfig, 'github' | 'google' | 'apple' | 'dev'>) =>
  [c.github && 'github', c.google && 'google', c.apple && 'apple', c.dev && 'dev'].filter(Boolean) as ('github' | 'google' | 'apple' | 'dev')[];

export function createAuth(c: AuthConfig) {
  const rpID = new URL(c.appOrigin).hostname;
  return betterAuth({
    appName: 'Length³ OS',
    baseURL: c.baseURL,
    secret: c.secret,
    database: drizzleAdapter(c.db, {provider: 'pg', schema}),
    // Apple answers by posting the sign-in back from its own page.
    trustedOrigins: [c.appOrigin, ...(c.origins ?? []), ...(c.apple ? ['https://appleid.apple.com'] : [])],
    emailAndPassword: {enabled: false},
    socialProviders: {
      ...(c.github ? {github: {clientId: c.github.clientId, clientSecret: c.github.clientSecret}} : {}),
      ...(c.google ? {google: {clientId: c.google.clientId, clientSecret: c.google.clientSecret, prompt: 'select_account' as const}} : {}),
      ...(c.apple ? {apple: {clientId: c.apple.clientId, clientSecret: c.apple.clientSecret}} : {}),
    },
    // One person, one account: a second provider with the same verified address joins it.
    account: {accountLinking: {enabled: true, trustedProviders: ['github', 'google', 'apple', 'dev']}},
    session: {expiresIn: 60 * 60 * 24 * 60, updateAge: 60 * 60 * 24},
    rateLimit: {enabled: c.rateLimit ?? true, window: 60, max: 120},
    // A sign-in with a passkey is proof the person is at the device just now: turning a repo
    // off (and setting the code for it) asks for a session made that way minutes ago.
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/passkey/verify-authentication') return;
        const made = ctx.context.newSession;
        if (made) await c.db.insert(schema.passkeyProof).values({sessionId: made.session.id, userId: made.user.id}).onConflictDoNothing();
      }),
    },
    plugins: [
      passkey({
        rpID,
        rpName: 'Length³ OS',
        origin: c.appOrigin,
        authenticatorSelection: {residentKey: 'required', userVerification: 'preferred'},
      }),
      bearer(),
      deviceAuthorization({
        verificationUri: `${c.appOrigin}/?device`,
        validateClient: (id: string) => (DEVICE_CLIENTS as readonly string[]).includes(id),
        expiresIn: '10m',
        interval: '2s',
      }),
      ...(c.dev ? [genericOAuth({config: [{
        providerId: 'dev', clientId: 'dev', clientSecret: 'dev',
        authorizationUrl: `${c.baseURL}/dev-oauth/authorize`,
        tokenUrl: `${c.baseURL}/dev-oauth/token`,
        userInfoUrl: `${c.baseURL}/dev-oauth/userinfo`,
        scopes: ['profile', 'email'],
      }]})] : []),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
