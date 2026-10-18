// What this Remote is, to anyone who asks before signing in: how one signs
// in here (the providers, passkeys, or a link for a Remote for research),
// its domain, and the app's origin a device's code is approved on; and
// whether it answers from its database.
//
//   GET /v1/about    {passkey, providers, domain, app?, enter?}
//   GET /v1/health   {ok: true} | 503 {ok: false}: one read, nothing written, nothing said of what failed

import {sql} from 'drizzle-orm';
import type {Hono} from 'hono';
import type {Db, Vars} from './request.ts';

export function about(d: {db: Db; providers: string[]; domain: string; appOrigin?: string; enter: boolean}, app: Hono<Vars>) {
  app.get('/v1/about', (c) => c.json({passkey: !d.enter, providers: d.enter ? [] : d.providers, domain: d.domain,
    ...(d.appOrigin ? {app: d.appOrigin} : {}), ...(d.enter ? {enter: true} : {})}));
  // What a deploy (deploy.ts) and a watch on the Remote ask. A Remote with no bucket is healthy: files are another matter (bucket.ts).
  app.get('/v1/health', async (c) => {
    try {
      await d.db.execute(sql`select 1`);
      return c.json({ok: true});
    } catch (e) {
      console.error('health', e);
      return c.json({ok: false, error: 'The Remote does not reach its database'}, 503);
    }
  });
}
