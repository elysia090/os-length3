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
    // One statement, one round trip: the count, and each board's newest post by another, found by its index
    // (board_id, id) from the newest down. (Two before: the look a page takes every 20 s paid for both.)
    const [r] = await rows<{inbox: number; boards: {id: string; server: string; post: string}[] | null}>(d.db, sql`select
      (select count(*)::int from message m where m.to_user = ${me} and m.read_at is null
        and not exists (select 1 from contact k where k.user_id = ${me} and k.peer = m.from_user and k.state = 'blocked')) as inbox,
      (select json_agg(json_build_object('id', x.id, 'server', x.server, 'post', x.post) order by x.created_at) from (
        select b.id, b.server_id as server, n.post, b.created_at
        from server_member sm
        join server s on s.id = sm.server_id and s.gone_at is null
        join board b on b.server_id = sm.server_id and b.gone_at is null
        left join board_seen r on r.board_id = b.id and r.user_id = ${me}
        cross join lateral (select p.id as post from board_post p where p.board_id = b.id and (p.user_id is null or p.user_id <> ${me})
          order by p.id desc limit 1) n
        where sm.user_id = ${me} and n.post > coalesce(r.post, '')) x) as boards`);
    return c.json({inbox: r.inbox, boards: r.boards ?? []});
  });
}
