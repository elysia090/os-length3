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
//
//   /api/auth/*   Better Auth: sign-in (social, passkey), sessions and devices
//                 (get-session, list-sessions, revoke-session, sign-out), linked
//                 providers, and the device flow (device/code, device/token,
//                 device, device/approve, device/deny)
//   /dev-oauth/*  the stand-in provider, only where 'dev' is offered (devoauth.ts)
// and signedIn, which every /v1 route behind it asks first.

import {passkey} from '@better-auth/passkey';
import {betterAuth} from 'better-auth';
import {createAuthMiddleware} from 'better-auth/api';
import {drizzleAdapter} from 'better-auth/adapters/drizzle';
import {bearer, deviceAuthorization, genericOAuth} from 'better-auth/plugins';
import type {Hono, MiddlewareHandler} from 'hono';
import {devOAuth} from './devoauth.ts';
import type {Vars} from './request.ts';
import * as schema from './schema.ts';

/** The desktop app and l3, the only clients that may ask for a device code. */
const DEVICE_CLIENTS = ['length3-app', 'l3'] as const;

export interface Provider { clientId: string; clientSecret: string }

export interface AuthConfig {
  // Drizzle database of any Postgres driver (Neon in production, PGlite in tests).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
  secret: string;
  /** Where this service is, e.g. https://os.length3.com. */
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
  /**
   * A Remote for research (enter.ts): no identity is admitted but the one
   * account's, under this address, and a session lasts a day from when it
   * was made, never drawn out by use.
   */
  only?: string;
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
    session: c.only ? {expiresIn: 60 * 60 * 24, disableSessionRefresh: true} : {expiresIn: 60 * 60 * 24 * 60, updateAge: 60 * 60 * 24},
    // For research, no provider admits anyone: the one account is entered by its link alone.
    ...(c.only ? {user: {validateUserInfo: ({user}: {user: {email?: string | null}}) =>
      (user.email === c.only ? undefined : {error: 'closed', errorDescription: 'This Remote takes no new accounts'})}} : {}),
    // Counted in the database: on Workers each isolate has a memory of its own (Better Auth's default store).
    rateLimit: {enabled: c.rateLimit ?? true, window: 60, max: 120, storage: 'database'},
    // Who is asking is the address Cloudflare saw, as everywhere on the Remote (enter.ts, servers.ts): Better
    // Auth reads only X-Forwarded-For unless told, which a Worker's request need not carry, and without an
    // address it counts everyone in one bucket a path (three sign-ins in ten seconds, for all).
    advanced: {ipAddress: {ipAddressHeaders: ['cf-connecting-ip']}},
    // A sign-in with a passkey is proof the person is at the device just now: turning a repo
    // off (and setting the code for it) asks for a session made that way minutes ago. Only the
    // latest is kept: one sign-in proves one session.
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/passkey/verify-authentication') return;
        const made = ctx.context.newSession;
        if (!made) return;
        const proof = {proofSession: made.session.id, proofAt: new Date()};
        await c.db.insert(schema.guard).values({userId: made.user.id, ...proof}).onConflictDoUpdate({target: schema.guard.userId, set: proof});
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

/** Sign-in's own routes: Better Auth's, and the stand-in provider where it is offered. */
export function signIn(d: {auth: Auth; providers: string[]; enter: boolean}, app: Hono<Vars>) {
  // For research no passkey is added: a passkey would let a link's holder back in after its key changed.
  if (d.enter) app.all('/api/auth/passkey/*', (c) => c.json({error: 'This Remote is entered by its link'}, 403));
  // Better Auth lists a person's sessions only for a session made within a day (its freshAge), but a
  // session here lasts 60 days, and the list is no secret of anyone else's: it is the Devices part, and
  // a day after signing in it would stop answering. Each session is read as Better Auth reads it, for the
  // session asking; what is sensitive (unlinking a sign-in) keeps the fresh rule.
  app.get('/api/auth/list-sessions', async (c) => {
    const s = await d.auth.api.getSession({headers: c.req.raw.headers});
    if (!s) return c.json({message: 'Unauthorized', code: 'UNAUTHORIZED'}, 401);
    const ctx = await d.auth.$context;
    const now = Date.now();
    const list = (await ctx.internalAdapter.listSessions(s.user.id, {onlyActiveSessions: true})).filter((x) => new Date(x.expiresAt).getTime() > now);
    return c.json(list.map((x) => ({id: x.id, token: x.token, userId: x.userId, expiresAt: x.expiresAt, createdAt: x.createdAt, updatedAt: x.updatedAt,
      ipAddress: x.ipAddress ?? null, userAgent: x.userAgent ?? null})));
  });
  app.on(['GET', 'POST'], '/api/auth/*', (c) => d.auth.handler(c.req.raw));
  if (d.providers.includes('dev')) app.route('/dev-oauth', devOAuth());
}

/**
 * Who is asking, or 401: a bearer token (the app, l3, the web once it took its token), or the session
 * cookie. A page elsewhere can make a browser send the cookie, never the bearer token: a write that
 * comes with the cookie alone is taken only from the app's own pages.
 */
export const signedIn = (auth: Auth, origins: string[]): MiddlewareHandler<Vars> => async (c, next) => {
  const bearer = /^Bearer\s/i.test(c.req.header('Authorization') ?? '');
  if (!bearer && c.req.method !== 'GET' && c.req.method !== 'HEAD' && !origins.includes(c.req.header('Origin') ?? '')) return c.json({error: 'not from the app'}, 403);
  const s = await auth.api.getSession({headers: c.req.raw.headers});
  if (!s) return c.json({error: 'not signed in'}, 401);
  c.set('userId', s.user.id);
  c.set('sessionId', s.session.id);
  c.set('name', s.user.name);
  await next();
};
