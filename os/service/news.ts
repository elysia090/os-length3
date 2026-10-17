// What came in that one has not seen, for the rail's marks: one cheap read,
// asked every little while by the app.
//
//   GET /v1/news   {inbox, boards}
//
// inbox: messages to one not read yet, but from someone one blocked (the
// Inbox's own count, which goes when a conversation is opened). boards: the
// boards of one's servers with a post by someone else past what one has had
// on screen (board_seen, POST /v1/boards/ID/seen), each with its server and
// the newest such post (so a device that just read it knows it is not new). Only
// one's own: it is read by the session's account, and names nothing else.

import type {Hono} from 'hono';
import {sql} from 'drizzle-orm';
import {rows, type Db, type Vars} from './request.ts';

export function news(d: {db: Db}, v1: Hono<Vars>) {
  v1.get('/news', async (c) => {
    const me = c.get('userId');
    const [{inbox}] = await rows<{inbox: number}>(d.db, sql`select count(*)::int as inbox from message m where m.to_user = ${me} and m.read_at is null
      and not exists (select 1 from contact k where k.user_id = ${me} and k.peer = m.from_user and k.state = 'blocked')`);
    // Each board's newest post by another, found by its index (board_id, id) from the newest down.
    const boards = await rows<{id: string; server: string; post: string}>(d.db, sql`select b.id, b.server_id as server, n.post
      from server_member sm
      join server s on s.id = sm.server_id and s.gone_at is null
      join board b on b.server_id = sm.server_id and b.gone_at is null
      left join board_seen r on r.board_id = b.id and r.user_id = ${me}
      cross join lateral (select p.id as post from board_post p where p.board_id = b.id and (p.user_id is null or p.user_id <> ${me})
        order by p.id desc limit 1) n
      where sm.user_id = ${me} and n.post > coalesce(r.post, '')
      order by b.created_at`);
    return c.json({inbox, boards});
  });
}
