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
// The build of Better Auth without Kysely, its own database layer (700 KB of the Worker's 3.2 MB): Drizzle is this one's.
import {betterAuth} from 'better-auth/minimal';
import {APIError, createAuthMiddleware} from 'better-auth/api';
import {eq} from 'drizzle-orm';
import {drizzleAdapter} from 'better-auth/adapters/drizzle';
import {bearer, deviceAuthorization, genericOAuth} from 'better-auth/plugins';
import type {Hono, MiddlewareHandler} from 'hono';
import {devOAuth} from './devoauth.ts';
import {keyFor} from './keys.ts';
import {nameFor} from './names.ts';
import type {Db, Vars} from './request.ts';
import * as schema from './schema.ts';

/** The desktop app and l3, the only clients that may ask for a device code. */
const DEVICE_CLIENTS = ['length3-app', 'l3'] as const;

export interface Provider { clientId: string; clientSecret: string }

interface AuthConfig {
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
  /** This Remote's own domain: an account made here is given its username on it (names.ts nameFor). */
  domain?: string;
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
  // Asked every 5 s while a code waits (interval below): 12 a minute, and room for retries.
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

/** How long a sign-in stands for the person being at the device: five minutes. */
const JUST_NOW = 5 * 60_000;
type Guard = typeof schema.guard.$inferSelect | undefined;
/** This very session signed in with a passkey within five minutes: the person is at the device just now. */
export const passkeyJustNow = (g: Guard, sessionId: string) =>
  !!g?.proofAt && g.proofSession === sessionId && Date.now() - g.proofAt.getTime() < JUST_NOW;
/** This very session signed in, with a passkey or a provider, within five minutes. */
const signedJustNow = (g: Guard, sessionId: string) => passkeyJustNow(g, sessionId)
  || (!!g?.signedAt && g.signedSession === sessionId && Date.now() - g.signedAt.getTime() < JUST_NOW);

/**
 * What would let someone in for good (another device's session, a passkey or a provider of theirs) or shut the
 * person out (a passkey or a provider taken away): asked of a session signed in just now (signedJustNow), so a
 * session's token taken from a device, however long it lasts, does none of them, and whoever holds it is gone
 * when it is ended. Refused with `confirm`: the app signs in with a passkey and asks again.
 */
const HELD = ['/device/approve', '/passkey/generate-register-options', '/passkey/verify-registration', '/passkey/delete-passkey',
  '/link-social', '/unlink-account'];

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
    // A sign-in that fails where no page of the app's was named for it (a state run out at the provider, a callback
    // forged) goes back to the app, which says it on its sign-in card, never to a bare page of the Remote's.
    onAPIError: {errorURL: `${c.appOrigin}/?sign-in-failed`},
    socialProviders: {
      ...(c.github ? {github: {clientId: c.github.clientId, clientSecret: c.github.clientSecret}} : {}),
      ...(c.google ? {google: {clientId: c.google.clientId, clientSecret: c.google.clientSecret, prompt: 'select_account' as const}} : {}),
      ...(c.apple ? {apple: {clientId: c.apple.clientId, clientSecret: c.apple.clientSecret}} : {}),
    },
    // One person, one account: a second provider with the same verified address joins it. Verified by that provider,
    // each time: no provider is "trusted" (Better Auth's trustedProviders joins one whose provider says the address is
    // not proven, so whoever typed someone's address at a provider that does not check it was signed in as them),
    // and the account joined must have had its own address proven (requireLocalEmailVerified, Better Auth's default).
    account: {accountLinking: {enabled: true, trustedProviders: [], requireLocalEmailVerified: true}},
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
    // A username from the first sign-in, as anywhere: made of what the provider calls them, the next free one if
    // taken. Not given here (the Remote busy), it is given the first time one is needed.
    ...(c.domain ? {databaseHooks: {user: {create: {after: async (u: {id: string}) => {
      try { await nameFor(c.db, u.id, c.domain!); } catch { /* given when first needed */ }
    }}}}} : {}),
    // A provider's sign-in is a sign-in just now too (signedJustNow), never a passkey's.
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        const passkey = ctx.path === '/passkey/verify-authentication';
        if (!passkey && !/^\/(oauth2\/)?callback\//.test(ctx.path)) return;
        const made = ctx.context.newSession;
        if (!made) return;
        const now = new Date();
        const proof = {signedSession: made.session.id, signedAt: now, ...(passkey ? {proofSession: made.session.id, proofAt: now} : {})};
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
        // Each poll is a request and a count in the database (rate limits): every 5 s is 120 in its ten minutes, not 300.
        interval: '5s',
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
export function signIn(d: {auth: Auth; db: Db; providers: string[]; enter: boolean; /** The app's pages, which alone send the cookie (fromElsewhere). */ origins: string[]}, app: Hono<Vars>) {
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
    const {s, refused} = await askedBy(d.auth, c.req.raw, d.origins);
    if (!s) return refused;
    const ctx = await d.auth.$context;
    const now = Date.now();
    const list = (await ctx.internalAdapter.listSessions(s.user.id, {onlyActiveSessions: true})).filter((x) => new Date(x.expiresAt).getTime() > now);
    return c.json(list.map((x) => ({id: x.id, token: x.id === s.session.id ? x.token : `id:${x.id}`, userId: x.userId, expiresAt: x.expiresAt,
      createdAt: x.createdAt, updatedAt: x.updatedAt, ipAddress: x.ipAddress ?? null, userAgent: x.userAgent ?? null})));
  });
  app.post('/api/auth/revoke-session', async (c, next) => {
    const named = /^id:(.+)$/.exec(String((await c.req.raw.clone().json().catch(() => ({})) as {token?: unknown}).token ?? ''))?.[1];
    if (!named) return next();
    const {s, refused} = await askedBy(d.auth, c.req.raw, d.origins);
    if (!s) return refused;
    const ctx = await d.auth.$context;
    const it = (await ctx.internalAdapter.listSessions(s.user.id)).find((x) => x.id === named);
    if (it) await ctx.internalAdapter.deleteSession(it.token);
    forgetSessions();
    return c.json({status: true});
  });
  for (const path of HELD) {
    app.on(['GET', 'POST'], `/api/auth${path}`, async (c, next) => {
      const {s, refused} = await askedBy(d.auth, c.req.raw, d.origins);
      if (!s) return refused;
      const [g] = await d.db.select().from(schema.guard).where(eq(schema.guard.userId, s.user.id)) as Guard[];
      if (!signedJustNow(g, s.session.id)) return c.json({error: 'Confirm it is you first', confirm: true}, 403);
      return next();
    });
  }
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

/**
 * Whether `req`, naming the session by `cred`, is one a page elsewhere could have made a browser send: the cookie
 * alone (a bearer token is never sent by another site's page), on a write without one of the app's own Origins, or
 * on a read the browser says another site's page started (a link, an image, a frame, a script: Fetch Metadata, W3C;
 * ASVS 4.2.2, 13.2.3). The one rule for every route that takes the cookie: /v1 (signedIn) and the session routes
 * the Remote answers itself beside Better Auth's (signIn), which Better Auth's own origin check never sees.
 */
function fromElsewhere(cred: {kind: 'bearer' | 'cookie'}, req: Request, origins: string[]): boolean {
  if (cred.kind === 'bearer' || origins.includes(req.headers.get('Origin') ?? '')) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') return true;
  const site = req.headers.get('Sec-Fetch-Site');
  return site === 'cross-site' || site === 'same-site';
}

/**
 * The session a request to one of signIn's own routes is asked by, by its one credential (credentialOf: a made-up
 * bearer beside a cookie is no one, not the cookie's), from the app's pages as fromElsewhere says; else the refusal.
 */
async function askedBy(auth: Auth, req: Request, origins: string[]) {
  const cred = credentialOf(req.headers);
  if (cred && fromElsewhere(cred, req, origins)) return {refused: Response.json({message: 'Not from the app', code: 'FORBIDDEN'}, {status: 403})};
  const s = cred && await auth.api.getSession({headers: cred.headers});
  return s ? {s} : {refused: Response.json({message: 'Unauthorized', code: 'UNAUTHORIZED'}, {status: 401})};
}

/** Sessions signedIn looked up, kept a few seconds by this isolate (the Worker's: 10 s). */
const kept = new Map<string, {until: number; user: string; session: string; name: string; ends: number}>();
/** Let go of every session kept: one was ended (sign-out, revoke) and may be among them. */
const forgetSessions = () => kept.clear();

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
  if (fromElsewhere(cred, c.req.raw, origins)) return c.json({error: 'not from the app'}, 403);
  const now = Date.now(), had = keep ? kept.get(cred.key) : undefined;
  if (had && had.until > now) {
    c.set('userId', had.user); c.set('sessionId', had.session); c.set('name', had.name); c.set('sessionEnds', had.ends);
    return next();
  }
  const s = await auth.api.getSession({headers: cred.headers});
  if (!s) { kept.delete(cred.key); return c.json({error: 'not signed in'}, 401); }
  if (keep) {
    if (kept.size >= 1000) for (const [k, v] of kept) if (v.until <= now || kept.size >= 1000) kept.delete(k);
    kept.set(cred.key, {until: Math.min(now + keep, new Date(s.session.expiresAt).getTime()), user: s.user.id, session: s.session.id, name: s.user.name,
      ends: new Date(s.session.expiresAt).getTime()});
  }
  c.set('userId', s.user.id);
  c.set('sessionId', s.session.id);
  c.set('name', s.user.name);
  c.set('sessionEnds', new Date(s.session.expiresAt).getTime());
  await next();
};
