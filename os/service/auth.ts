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
import {APIError, createAuthMiddleware} from 'better-auth/api';
import {drizzleAdapter} from 'better-auth/adapters/drizzle';
import {bearer, deviceAuthorization, genericOAuth} from 'better-auth/plugins';
import type {Hono, MiddlewareHandler} from 'hono';
import {devOAuth} from './devoauth.ts';
import {keyFor} from './keys.ts';
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

/**
 * What each sign-in route may be asked, an address a minute, where Better Auth's 120 is too many (RFC
 * 8628 §5.1-5.2: a device code's user code is not found by trying, nor polled for faster than its
 * interval; OWASP ASVS 2.2.1: anti-automation on every way in). Social sign-in keeps Better Auth's
 * own, 3 in 10 seconds; looking a user code up (/device) its plugin's, 5 in the code's 10 minutes.
 */
export const AUTH_LIMITS: Record<string, {window: number; max: number} | false> = {
  // Read on every page load and by every client: counted at the edge (wrangler.toml LIMITER), not in the
  // database, which would be a read and a write each time.
  '/get-session': false,
  '/list-accounts': false,
  '/device/code': {window: 60, max: 10},
  // Asked every 2 s while a code waits (interval below): 30 a minute, and room for a retry.
  '/device/token': {window: 60, max: 40},
  '/device/approve': {window: 60, max: 10},
  '/device/deny': {window: 60, max: 10},
  '/passkey/generate-authenticate-options': {window: 60, max: 20},
  '/passkey/verify-authentication': {window: 60, max: 10},
  '/passkey/generate-register-options': {window: 60, max: 10},
  '/passkey/verify-registration': {window: 60, max: 10},
  '/revoke-session': {window: 60, max: 30},
  '/revoke-other-sessions': {window: 60, max: 10},
};

/** A passkey ceremony that did not verify the person (PIN, biometrics), refused: a passkey is the whole sign-in. */
const verifiedPerson = (ok: boolean | undefined) => {
  if (!ok) throw new APIError('UNAUTHORIZED', {message: 'This passkey did not verify you (a PIN or biometrics); use one that does'});
};

export function createAuth(c: AuthConfig) {
  const rpID = new URL(c.appOrigin).hostname;
  const https = c.baseURL.startsWith('https://');
  return betterAuth({
    appName: 'Length³ OS',
    baseURL: c.baseURL,
    // Sign-in's own key, derived from the one secret (keys.ts): never the key domain proofs or invitations are made with.
    secret: keyFor(c.secret, 'better-auth'),
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
    rateLimit: {enabled: c.rateLimit ?? true, window: 60, max: 120, storage: 'database', customRules: AUTH_LIMITS},
    // Who is asking is the address Cloudflare saw, as everywhere on the Remote (enter.ts, servers.ts): Better
    // Auth reads only X-Forwarded-For unless told, which a Worker's request need not carry, and without an
    // address it counts everyone in one bucket a path (three sign-ins in ten seconds, for all).
    //
    // Over HTTPS every cookie is a __Host- one: Secure, Path=/ and no Domain, so no other host under
    // length3.com can set or shadow it (RFC 6265bis §4.1.3.2; ASVS 3.4.1-3.4.4). HttpOnly and
    // SameSite=Lax are Better Auth's own for every cookie it sets.
    // A session is read with its user in one query (the relations are schema.auth.ts's), not two.
    advanced: {database: {joins: true}, ipAddress: {ipAddressHeaders: ['cf-connecting-ip']},
      ...(https ? {useSecureCookies: false, cookiePrefix: '__Host-length3', defaultCookieAttributes: {secure: true, path: '/'}} : {})},
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
        // The person is verified by the authenticator, every time: asked for when a passkey is made, and a
        // ceremony that says it did not verify them is refused, made or used (WebAuthn L3 §13.4.6; ASVS
        // 2.7, 2.9). Its counter is checked by SimpleWebAuthn (a clone is refused); attestation is
        // not asked for (any authenticator a person has is theirs to use).
        authenticatorSelection: {residentKey: 'required', userVerification: 'required'},
        registration: {afterVerification: ({verification}) => { verifiedPerson(verification.registrationInfo?.userVerified); return {}; }},
        authentication: {afterVerification: ({verification}) => verifiedPerson(verification.authenticationInfo.userVerified)},
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
  //
  // Another session's token is never said (it is that device's key: with it, anyone is that device): the session
  // asking is told its own, by which a client knows which is itself, and each other is named `id:<its id>`, which
  // revoke-session takes in place of a token, for the asking account's own sessions alone.
  app.get('/api/auth/list-sessions', async (c) => {
    const s = await d.auth.api.getSession({headers: c.req.raw.headers});
    if (!s) return c.json({message: 'Unauthorized', code: 'UNAUTHORIZED'}, 401);
    const ctx = await d.auth.$context;
    const now = Date.now();
    const list = (await ctx.internalAdapter.listSessions(s.user.id, {onlyActiveSessions: true})).filter((x) => new Date(x.expiresAt).getTime() > now);
    return c.json(list.map((x) => ({id: x.id, token: x.id === s.session.id ? x.token : `id:${x.id}`, userId: x.userId, expiresAt: x.expiresAt,
      createdAt: x.createdAt, updatedAt: x.updatedAt, ipAddress: x.ipAddress ?? null, userAgent: x.userAgent ?? null})));
  });
  app.post('/api/auth/revoke-session', async (c, next) => {
    const named = /^id:(.+)$/.exec(String((await c.req.raw.clone().json().catch(() => ({})) as {token?: unknown}).token ?? ''))?.[1];
    if (!named) return next();
    const s = await d.auth.api.getSession({headers: c.req.raw.headers});
    if (!s) return c.json({message: 'Unauthorized', code: 'UNAUTHORIZED'}, 401);
    const ctx = await d.auth.$context;
    const it = (await ctx.internalAdapter.listSessions(s.user.id)).find((x) => x.id === named);
    if (it) await ctx.internalAdapter.deleteSession(it.token);
    forgetSessions();
    return c.json({status: true});
  });
  app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
    const res = await d.auth.handler(c.req.raw);
    // A session ended here is not taken as still there from what signedIn keeps.
    if (res.ok && /\/(sign-out|revoke-session|revoke-sessions|revoke-other-sessions)$/.test(c.req.path)) forgetSessions();
    // Asked too often: said as everywhere on the Remote (request.ts slowDown), Retry-After and retryAfter,
    // beside Better Auth's own X-Retry-After.
    const wait = res.status === 429 ? res.headers.get('X-Retry-After') : null;
    if (!wait) return res;
    return c.json({error: 'Too many requests; try again later', retryAfter: Number(wait)}, 429, {'Retry-After': wait, 'X-Retry-After': wait});
  });
  if (d.providers.includes('dev')) app.route('/dev-oauth', devOAuth());
}

/** The session cookie by its exact name (createAuth: `__Host-length3` over HTTPS, Better Auth's own name otherwise). */
const SESSION_COOKIES = ['__Host-length3.session_token', 'better-auth.session_token'];

/** The one credential a request names: its bearer token, else its session cookie by that exact name; null when neither. */
export function credentialOf(headers: Headers): {kind: 'bearer' | 'cookie'; key: string; headers: Headers} | null {
  const bearer = /^Bearer ([^\s]+)$/.exec(headers.get('Authorization') ?? '')?.[1];
  if (bearer) return {kind: 'bearer', key: `b:${bearer}`, headers: new Headers({Authorization: `Bearer ${bearer}`})};
  for (const part of (headers.get('Cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    const name = part.slice(0, at).trim(), value = part.slice(at + 1).trim();
    if (at > 0 && SESSION_COOKIES.includes(name) && value) return {kind: 'cookie', key: `c:${name}=${value}`, headers: new Headers({Cookie: `${name}=${value}`})};
  }
  return null;
}

/** Sessions signedIn looked up, kept a few seconds by this isolate (the Worker's: 10 s). */
const kept = new Map<string, {until: number; user: string; session: string; name: string}>();
/** Let go of every session kept: one was ended (sign-out, revoke) and may be among them. */
export const forgetSessions = () => kept.clear();

/**
 * Who is asking, or 401: a bearer token (the app, l3, the web once it took its token), or the session
 * cookie. A page elsewhere can make a browser send the cookie, never the bearer token: a write that
 * comes with the cookie alone is taken only from the app's own pages.
 *
 * The session is looked up from that one credential alone, the rest of the request's headers left out, so
 * what is kept (`keep` ms, never past the session's end) is kept under what was looked up: a request that
 * names a bearer is that bearer's or no one's, never a cookie's beside it, and a cookie only by its exact name.
 */
export const signedIn = (auth: Auth, origins: string[], keep = 0): MiddlewareHandler<Vars> => async (c, next) => {
  const cred = credentialOf(c.req.raw.headers);
  // Nothing that could name a session: refused before the database is asked anything.
  if (!cred) return c.json({error: 'not signed in'}, 401);
  const bearer = cred.kind === 'bearer';
  const ours = origins.includes(c.req.header('Origin') ?? '');
  if (!bearer && c.req.method !== 'GET' && c.req.method !== 'HEAD' && !ours) return c.json({error: 'not from the app'}, 403);
  // A read with the cookie alone that the browser says another site's page started (a link, an
  // image, a frame, a script) is refused too: no page elsewhere has the Remote read for it with
  // someone's cookie, whatever a GET would do (Fetch Metadata, W3C; ASVS 4.2.2, 13.2.3).
  const site = c.req.header('Sec-Fetch-Site');
  if (!bearer && (site === 'cross-site' || site === 'same-site') && !ours) return c.json({error: 'not from the app'}, 403);
  const now = Date.now(), had = keep ? kept.get(cred.key) : undefined;
  if (had && had.until > now) {
    c.set('userId', had.user); c.set('sessionId', had.session); c.set('name', had.name);
    return next();
  }
  const s = await auth.api.getSession({headers: cred.headers});
  if (!s) { kept.delete(cred.key); return c.json({error: 'not signed in'}, 401); }
  if (keep) {
    if (kept.size >= 1000) for (const [k, v] of kept) if (v.until <= now || kept.size >= 1000) kept.delete(k);
    kept.set(cred.key, {until: Math.min(now + keep, new Date(s.session.expiresAt).getTime()), user: s.user.id, session: s.session.id, name: s.user.name});
  }
  c.set('userId', s.user.id);
  c.set('sessionId', s.session.id);
  c.set('name', s.user.name);
  await next();
};
