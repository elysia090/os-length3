// Recovery, the plain way: one code per account, shown once, kept by the
// person (written down, in a password manager). It opens the account when
// every passkey is gone, once: using it spends it, and the account then
// asks for a new passkey and shows a new code. Only the code's digest is
// stored, so the database cannot sign anyone in. A code has 120 random bits:
// guessing is not a way in, and attempts are rate-limited besides.
//
// An account starts blank (Better Auth's anonymous user) and stops being
// blank the moment it has a way back in: a passkey or a recovery code. Only
// a blank one is ever cleaned away, when its browser signs in to another.

import type {BetterAuthPlugin} from 'better-auth';
import {APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx, sessionMiddleware} from 'better-auth/api';
import {setSessionCookie} from 'better-auth/cookies';
import * as z from 'zod';

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0, O, 1, I: none to mistake for another

/** A new code: 24 symbols of 5 bits, written in six groups of four. */
export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const symbols = [...bytes].map((b) => ALPHABET[b & 31]);
  return Array.from({length: 6}, (_, i) => symbols.slice(i * 4, i * 4 + 4).join('')).join('-');
}

/** The same code however it was typed: case, spaces and dashes do not matter. */
export function normal(code: string): string {
  return code.toUpperCase().replace(/[\s-]+/g, '');
}

export async function digest(code: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`length3-recovery:${normal(code)}`)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const recovery = () => ({
  id: 'recovery',
  schema: {
    user: {
      fields: {
        recoveryDigest: {type: 'string', required: false, unique: true, input: false, returned: false},
      },
    },
  },
  endpoints: {
    /** A new code for the signed-in account; the one before stops working. */
    createRecoveryCode: createAuthEndpoint('/recovery/create', {method: 'POST', use: [sessionMiddleware]}, async (ctx) => {
      const code = newCode();
      await ctx.context.internalAdapter.updateUser(ctx.context.session.user.id, {recoveryDigest: await digest(code), isAnonymous: false});
      return ctx.json({code});
    }),
    /** Whether the signed-in account has a code to fall back on. */
    recoveryStatus: createAuthEndpoint('/recovery/status', {method: 'GET', use: [sessionMiddleware]}, async (ctx) => {
      const users = await ctx.context.adapter.findMany<{id: string; recoveryDigest: string | null}>({
        model: 'user', where: [{field: 'id', value: ctx.context.session.user.id}],
      });
      return ctx.json({hasCode: Boolean(users[0]?.recoveryDigest)});
    }),
    /** Sign in with the code; it is spent, and a new one must be made. */
    signInRecovery: createAuthEndpoint('/sign-in/recovery', {method: 'POST', body: z.object({code: z.string().min(8).max(64)})}, async (ctx) => {
      const users = await ctx.context.adapter.findMany<{id: string}>({
        model: 'user', where: [{field: 'recoveryDigest', value: await digest(ctx.body.code)}],
      });
      const found = users[0];
      if (!found) throw new APIError('UNAUTHORIZED', {message: 'この復旧コードでは入れません'});
      const user = await ctx.context.internalAdapter.updateUser(found.id, {recoveryDigest: null});
      const session = await ctx.context.internalAdapter.createSession(found.id);
      if (!session || !user) throw new APIError('INTERNAL_SERVER_ERROR', {message: '入れませんでした'});
      await setSessionCookie(ctx, {session, user});
      return ctx.json({token: session.token, spent: true});
    }),
  },
  hooks: {
    after: [{
      matcher: (ctx: {path?: string}) => ctx.path === '/passkey/verify-registration',
      handler: createAuthMiddleware(async (ctx) => {
        const s = await getSessionFromCtx(ctx).catch(() => null);
        if (s && (s.user as {isAnonymous?: boolean}).isAnonymous) await ctx.context.internalAdapter.updateUser(s.user.id, {isAnonymous: false});
      }),
    }],
  },
  rateLimit: [{pathMatcher: (path: string) => path === '/sign-in/recovery', window: 60, max: 5}],
}) satisfies BetterAuthPlugin;
