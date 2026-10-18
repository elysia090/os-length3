import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sql} from 'drizzle-orm';
import * as schema from './schema.ts';
import {sha256} from './request.ts';
import {sweep} from './sweep.ts';
import {count, enc, idOf, named, sessionOf, sharedService, upload} from './testing.ts';

// The Remote's endpoints as contracts: who may ask what, every step of a
// repo turned off and on, and the shape of each refusal. One Remote for the
// whole file; each test signs in as people of its own, so none depends on
// another, or on their order.
//
// The file runs twice: with a bucket, and without one (contract.nobucket.test.ts),
// where every route that does not move bytes must answer as it does here,
// and those that would say once that files are not kept. verify.ts runs it
// without a bucket against a real Postgres.

const s = await sharedService();
const DAY = 86_400_000;

/** A repo with all a repo has: a commit on main, a line of work on its issue with a commit, pushed, and its change. */
async function fullRepo(t: string, name: string) {
  const readme = (await upload(s, t, enc.encode(`# ${name}\n`))).sha, issue = (await upload(s, t, enc.encode('Fix：x\n'))).sha, fix = (await upload(s, t, enc.encode('fixed\n'))).sha;
  assert.equal((await s.call('PATCH', `/v1/repos/${name}/draft`, {token: t, body: {version: 0, set: {'README.md': readme, 'issue/001.md': issue}, remove: []}})).status, 200);
  const cut = (await s.call('POST', `/v1/repos/${name}/cuts`, {token: t, body: {version: 1, parent: null, title: 'start'}})).json.id as string;
  assert.equal((await s.call('POST', `/v1/repos/${name}/lines`, {token: t, body: {issue: 'issue/001.md'}})).status, 201);
  assert.equal((await s.call('PATCH', `/v1/repos/${name}/draft?line=001`, {token: t, body: {version: 1, set: {'fix.c': fix}, remove: []}})).status, 200);
  const parent = (await s.call('GET', `/v1/repos/${name}?line=001`, {token: t})).json.head;
  const work = (await s.call('POST', `/v1/repos/${name}/cuts?line=001`, {token: t, body: {version: 2, parent, title: 'fix'}})).json.id as string;
  assert.equal((await s.call('POST', `/v1/repos/${name}/lines/001/push`, {token: t, body: {head: work}})).status, 200);
  const change = await s.call('POST', `/v1/repos/${name}/changes`, {token: t, body: {line: '001', title: 'fix'}});
  assert.equal(change.status, 201, change.text);
  return {cut, work, change: change.json.id as string, blob: readme};
}

/** Proof that the person is at this device just now (a passkey sign-in), `ago` ms ago, for the session `t` is. */
async function proven(t: string, ago = 0) {
  const user = await idOf(s, t), session = await sessionOf(s, t);
  const at = new Date(Date.now() - ago);
  await s.db.insert(schema.guard).values({userId: user, proofSession: session, proofAt: at})
    .onConflictDoUpdate({target: schema.guard.userId, set: {proofSession: session, proofAt: at}});
}
/** The account's name, as turning a repo off asks for it. */
const nameOf = async (t: string) => ((await s.call('GET', '/api/auth/get-session', {token: t})).json as unknown as {user: {name: string}}).user.name;

/** Someone with a repo, proven just now, the code set: ready to turn it off. */
async function owner(word: string, repo: string) {
  const t = await s.person(word);
  const r = await fullRepo(t, repo);
  await proven(t);
  assert.equal((await s.call('POST', '/v1/off-code', {token: t, body: {code: 'AB12C'}})).status, 200);
  const asked = {name: await nameOf(t), repo, code: 'AB12C'};
  return {t, ...r, asked};
}

/** Every refusal is JSON with words saying why. */
function refused(r: {status: number; json: unknown; text: string}, status: number, error?: string | RegExp) {
  assert.equal(r.status, status, r.text);
  const said = (r.json as {error?: unknown} | null)?.error;
  if (error !== undefined) {
    assert.equal(typeof said, 'string', r.text);
    if (typeof error === 'string') assert.equal(said, error); else assert.match(said as string, error);
  }
}

// ---- another account's work ----

test('another account\'s repo answers as if it were not there, by every route a repo has, and is left as it was', async () => {
  const a = await s.person('Owner'), b = await s.person('Other');
  const r = await fullRepo(a, 'shared-name');
  const before = (await s.call('GET', '/v1/repos/shared-name', {token: a})).json;
  const asB = (method: string, path: string, body?: unknown) => s.call(method, path, {token: b, body});
  refused(await asB('GET', '/v1/repos/shared-name'), 404, 'That repo is not on the Remote');
  refused(await asB('GET', '/v1/repos/shared-name?line=001'), 404);
  refused(await asB('GET', `/v1/repos/shared-name/cuts/${r.cut}`), 404, 'No such commit');
  // With no bucket, no file is anyone's to read: the same answer to everyone, before whose it is.
  refused(await asB('GET', `/v1/blobs/${r.blob}`), s.files ? 404 : 503);
  // Reads of lists answer nothing of A's.
  assert.deepEqual((await asB('GET', '/v1/repos/shared-name/log')).json, []);
  assert.deepEqual((await asB('GET', '/v1/repos/shared-name/lines')).json, []);
  assert.deepEqual((await asB('GET', '/v1/repos/shared-name/changes')).json, []);
  assert.deepEqual((await asB('POST', '/v1/blobs/missing', [r.blob])).json, [r.blob]);
  // Writes reach nothing of A's.
  refused(await asB('POST', '/v1/repos/shared-name/cuts', {version: 1, parent: null, title: 'mine'}), 409);
  refused(await asB('POST', '/v1/repos/shared-name/lines', {issue: 'issue/001.md'}), 404);
  refused(await asB('POST', '/v1/repos/shared-name/lines/001/push', {head: r.work}), 404);
  refused(await asB('POST', '/v1/repos/shared-name/changes', {line: '001', title: 'x'}), 404);
  refused(await asB('POST', `/v1/repos/shared-name/changes/${r.change}/reviews`, {version: 1, verdict: 'approve'}), 404, 'No such change');
  refused(await asB('POST', `/v1/repos/shared-name/changes/${r.change}/merge`, {version: 1}), 404, 'No such change');
  for (const verb of ['reject', 'reset']) refused(await asB('POST', `/v1/repos/shared-name/changes/${r.change}/${verb}`, {}), 404, 'No such change');
  refused(await asB('PATCH', '/v1/repos/shared-name/draft?line=001', {version: 2, set: {}, remove: ['fix.c']}), 404, 'That work is not on the Remote');
  refused(await asB('POST', '/v1/repos/shared-name/on'), 404);
  // B proven, with a code of its own, still cannot turn A's off or discard it.
  await proven(b);
  await s.call('POST', '/v1/off-code', {token: b, body: {code: 'AB12C'}});
  const asked = {name: await nameOf(b), repo: 'shared-name', code: 'AB12C'};
  refused(await asB('POST', '/v1/repos/shared-name/off', asked), 404);
  refused(await asB('POST', '/v1/repos/shared-name/discard', asked), 404);
  // A writing to the same name makes B a repo of B's own; A's is as it was.
  assert.equal((await asB('PATCH', '/v1/repos/shared-name/draft', {version: 0, set: {}, remove: []})).status, 200);
  assert.deepEqual((await s.call('GET', '/v1/repos/shared-name', {token: a})).json, before);
  assert.deepEqual(((await s.call('GET', '/v1/repos/shared-name/changes', {token: a})).json as unknown as {state: string}[]).map((c) => c.state), ['open']);
});

test('another account\'s servers and boards answer as if they were not there', async () => {
  const a = await s.person('Host'), b = await s.person('Stranger');
  const handle = `h${process.pid}${Date.now().toString(36)}`.slice(0, 20);
  await named(s, [a, handle]);
  const made = await s.call('POST', '/v1/servers', {token: a, body: {name: 'Private'}});
  assert.equal(made.status, 201, made.text);
  const sid = made.json.id as string, bid = (made.json.boards as {id: string}[])[0].id;
  const asB = (method: string, path: string, body?: unknown) => s.call(method, path, {token: b, body});
  assert.deepEqual((await asB('GET', '/v1/servers')).json, []);
  for (const [m, p, body] of [
    ['GET', `/v1/servers/${sid}/people`], ['PATCH', `/v1/servers/${sid}`, {name: 'Mine now'}], ['POST', `/v1/servers/${sid}/boards`, {name: 'x'}],
    ['POST', `/v1/servers/${sid}/people`, {address: 'x'}], ['GET', `/v1/servers/${sid}/repos`],
  ] as [string, string, unknown?][]) refused(await asB(m, p, body), 404, /No such server/);
  // Removing it is its owner's: anyone else hears the same as of a server that is not there at all.
  const remove = await asB('DELETE', `/v1/servers/${sid}`), none = await asB('DELETE', '/v1/servers/nonenonenone');
  refused(remove, 403, 'Only its owner removes a server');
  assert.deepEqual([remove.status, remove.json], [none.status, none.json]);
  for (const [m, p, body] of [
    ['GET', `/v1/boards/${bid}`], ['GET', `/v1/boards/${bid}/posts`], ['GET', `/v1/boards/${bid}/todos`], ['POST', `/v1/boards/${bid}/posts`, {body: 'hi'}],
    ['PUT', `/v1/boards/${bid}/todos/t1`, {title: 'x', place: 1}], ['PATCH', `/v1/boards/${bid}`, {open: true}], ['DELETE', `/v1/boards/${bid}`],
  ] as [string, string, unknown?][]) refused(await asB(m, p, body), 404, /No such board/);
  // Nor is it open to anyone: a board is not shown to everyone until its owner says so.
  refused(await s.call('GET', `/v1/open/${bid}`), 404);
  assert.equal(((await s.call('GET', `/v1/servers/${sid}/people`, {token: a})).json as unknown[]).length, 1);
});

// SSH is per device now (service/ssh.ts and its tests); a name carries no SSH of its own.
test('another account\'s addresses: not let go or renewed by anyone else', async () => {
  const a = await s.person('Addressed'), b = await s.person('Other');
  const handle = `a${process.pid}${Date.now().toString(36)}`.slice(0, 20);
  await named(s, [a, handle]);
  const address = `${handle}@length3.test`;
  refused(await s.call('DELETE', `/v1/inbox/addresses/${address}`, {token: b}), 404, 'That name is not yours');
  refused(await s.call('POST', `/v1/inbox/addresses/${address}/renew`, {token: b, body: {}}), 404, 'That name is not yours');
  const me = (await s.call('GET', '/v1/inbox/me', {token: a})).json as unknown as {addresses: {address: string}[]};
  assert.deepEqual(me.addresses.map((x) => x.address), [address]);
});

test('a message goes out from the sender\'s own address, whatever address it says it is from', async () => {
  const a = await s.person('Sender'), b = await s.person('Reader'), c = await s.person('Bystander');
  const [ha, hb, hc] = ['s', 'r', 'b'].map((x) => `${x}${process.pid}${Date.now().toString(36)}`.slice(0, 20));
  await named(s, [a, ha], [b, hb], [c, hc]);
  const sent = await s.call('POST', '/v1/inbox/messages', {token: a, body: {to: hb, from: `${hc}@length3.test`, body: 'it is me'}});
  assert.equal(sent.status, 201, sent.text);
  const threads = (await s.call('GET', '/v1/inbox/threads', {token: b})).json as unknown as {address: string}[];
  assert.deepEqual(threads.map((t) => t.address), [`${ha}@length3.test`]);
  assert.deepEqual((await s.call('GET', '/v1/inbox/threads', {token: c})).json, []);
  refused(await s.call('POST', '/v1/inbox/messages', {token: a, body: {to: ha, body: 'to myself'}}), 400, 'That is you');
});

// ---- turning a repo off, on, and discarding it ----

test('off asks for a passkey just now, from this very session, the names and the code; each refusal says which', async () => {
  const o = await owner('Careful', 'guarded');
  const off = (body: unknown, t = o.t) => s.call('POST', '/v1/repos/guarded/off', {token: t, body});
  refused(await off({...o.asked, name: 'Someone else'}), 403, 'The names do not match.');
  refused(await off({...o.asked, repo: 'other'}), 403, 'The names do not match.');
  refused(await off({...o.asked, code: 'ZZZZZ'}), 403, 'That is not the code.');
  refused(await off({...o.asked, code: 'AB12'}), 403, 'That is not the code.');
  refused(await off(null), 403, 'The names do not match.');
  // A passkey six minutes ago is not just now; one in another session of the same account is not this one.
  await proven(o.t, 6 * 60_000);
  refused(await off(o.asked), 403, 'Confirm with a passkey.');
  const other = await s.start(o.asked.name);
  await proven(other);
  refused(await off(o.asked), 403, 'Confirm with a passkey.');
  // The code's letters are taken in either case, and the name as written.
  await proven(o.t);
  const done = await off({...o.asked, name: ` ${o.asked.name.toUpperCase()} `, code: 'ab12c'});
  assert.equal(done.status, 200, done.text);
  assert.deepEqual(Object.keys(done.json).sort(), ['name', 'offAt', 'until']);
  assert.equal((done.json.until as number) - (done.json.offAt as number), 30 * DAY);
});

test('a repo turned off is kept 30 days from when it went off, asking again does not restart them, and every route says it is off', async () => {
  const o = await owner('Offing', 'resting');
  const first = (await s.call('POST', '/v1/repos/resting/off', {token: o.t, body: o.asked})).json as unknown as {offAt: number; until: number};
  await s.db.execute(sql`update repo set off_at = now() - interval '10 days' where name = 'resting' and user_id = ${await idOf(s, o.t)}`);
  const again = (await s.call('POST', '/v1/repos/resting/off', {token: o.t, body: o.asked})).json as unknown as {offAt: number; until: number};
  assert.ok(Math.abs(again.offAt - (first.offAt - 10 * DAY)) < 60_000, `${again.offAt} ${first.offAt}`);
  assert.equal(again.until - again.offAt, 30 * DAY);
  const listed = ((await s.call('GET', '/v1/repos', {token: o.t})).json as unknown as {name: string; offAt: number; until: number}[]).find((r) => r.name === 'resting')!;
  assert.deepEqual([listed.offAt, listed.until], [again.offAt, again.until]);
  // Off, it answers only that, with until when it can come back, on every route of it and every line.
  const asks: [string, string, unknown?][] = [
    ['GET', '/v1/repos/resting'], ['GET', '/v1/repos/resting?line=001'], ['GET', '/v1/repos/resting/log'], ['GET', '/v1/repos/resting/lines'],
    ['GET', `/v1/repos/resting/cuts/${o.cut}`],
    ['PATCH', '/v1/repos/resting/draft', {version: 1, set: {}, remove: []}], ['PATCH', '/v1/repos/resting/draft?line=001', {version: 2, set: {}, remove: []}],
    ['POST', '/v1/repos/resting/cuts', {version: 1, parent: o.cut, title: 'x'}], ['POST', '/v1/repos/resting/lines', {issue: 'issue/001.md'}],
  ];
  for (const [m, p, body] of asks) {
    const r = await s.call(m, p, {token: o.t, body});
    refused(r, 410, 'This repo is turned off');
    assert.deepEqual([r.json.offAt, r.json.until], [again.offAt, again.until], `${m} ${p}`);
  }
});

test('the 30 days are kept to the day: the sweep leaves a repo off 29 days, and lets one off 31 days go as gone', async () => {
  const t = await s.person('Holder');
  const me = await idOf(s, t);
  for (const n of ['day29', 'day31']) assert.equal((await s.call('PATCH', `/v1/repos/${n}/draft`, {token: t, body: {version: 0, set: {'a.txt': null}, remove: []}})).status, 200);
  await s.db.execute(sql`update repo set off_at = now() - interval '29 days' where user_id = ${me} and name = 'day29'`);
  await s.db.execute(sql`update repo set off_at = now() - interval '31 days' where user_id = ${me} and name = 'day31'`);
  await sweep(s.db, s.files);
  assert.deepEqual(((await s.call('GET', '/v1/repos', {token: t})).json as unknown as {name: string}[]).map((r) => r.name), ['day29']);
  assert.deepEqual(((await s.call('GET', '/v1/repos/gone', {token: t})).json as unknown as {name: string}[]).map((r) => r.name), ['day31']);
  refused(await s.call('GET', '/v1/repos/day31', {token: t}), 404, 'That repo is not on the Remote');
  // Back on before its days run out, it is whole: its draft as it was.
  assert.equal((await s.call('POST', '/v1/repos/day29/on', {token: t})).status, 200);
  assert.deepEqual(((await s.call('GET', '/v1/repos/day29', {token: t})).json as unknown as {draft: object}).draft, {'a.txt': null});
});

test('on brings a repo back at once, with all it had; asked of one already on, it says so and changes nothing', async () => {
  const o = await owner('Returning', 'back');
  const before = (await s.call('GET', '/v1/repos/back', {token: o.t})).json;
  assert.equal((await s.call('POST', '/v1/repos/back/off', {token: o.t, body: o.asked})).status, 200);
  const on = await s.call('POST', '/v1/repos/back/on', {token: o.t});
  assert.deepEqual([on.status, on.json], [200, {name: 'back', on: true}]);
  assert.deepEqual((await s.call('GET', '/v1/repos/back', {token: o.t})).json, before);
  assert.deepEqual(((await s.call('GET', '/v1/repos/back/changes', {token: o.t})).json as unknown as {state: string}[]).map((c) => c.state), ['open']);
  assert.deepEqual(((await s.call('GET', '/v1/repos/back/log', {token: o.t})).json as unknown[]).length, 1);
  // Again: on already, nothing moves.
  assert.deepEqual((await s.call('POST', '/v1/repos/back/on', {token: o.t})).json, {name: 'back', on: true});
  assert.deepEqual((await s.call('GET', '/v1/repos/back', {token: o.t})).json, before);
  refused(await s.call('POST', '/v1/repos/never/on', {token: o.t}), 404, 'That repo is not on the Remote');
});

test('discard is refused while the repo is on, and takes nothing of another repo of the same account', async () => {
  const o = await owner('Discarder', 'goes');
  await fullRepo(o.t, 'stays');
  refused(await s.call('POST', '/v1/repos/goes/discard', {token: o.t, body: o.asked}), 409, 'Turn it off first.');
  assert.equal((await s.call('POST', '/v1/repos/goes/off', {token: o.t, body: o.asked})).status, 200);
  assert.equal((await s.call('POST', '/v1/repos/goes/discard', {token: o.t, body: o.asked})).status, 200);
  const me = await idOf(s, o.t);
  const left = await count(s, sql`select count(*)::int as n from cut c join repo r on r.id = c.repo_id where r.user_id = ${me}`);
  assert.equal(left, 2);
  assert.deepEqual(((await s.call('GET', '/v1/repos', {token: o.t})).json as unknown as {name: string}[]).map((r) => r.name), ['stays']);
  assert.deepEqual(((await s.call('GET', '/v1/repos/stays/changes', {token: o.t})).json as unknown as unknown[]).length, 1);
});

// ---- what a request must be ----

test('a draft\'s diff: each malformed part is refused with words, and nothing is written', async () => {
  const t = await s.person('Writer');
  const sha = (await upload(s, t, enc.encode('x'))).sha;
  assert.equal((await s.call('PATCH', '/v1/repos/shape/draft', {token: t, body: {version: 0, set: {'a.txt': sha}, remove: []}})).status, 200);
  const patch = (body: unknown) => s.call('PATCH', '/v1/repos/shape/draft', {token: t, body});
  refused(await patch({set: {}, remove: []}), 400, 'a diff');
  refused(await patch({version: '1', set: {}, remove: []}), 400, 'a diff');
  refused(await patch({version: 1, set: [], remove: []}), 400, 'a diff');
  refused(await patch({version: 1, set: {}, remove: 'a.txt'}), 400, 'a diff');
  refused(await patch({version: 1, set: {'a.txt': 'not-a-digest'}, remove: []}), 400, 'A path no repo may have');
  for (const path of ['.git/config', '../x', '/abs', 'a//b', 'x/.GIT/hooks/pre-commit', 'git~1/config']) {
    const r = await patch({version: 1, set: {[path]: sha}, remove: []});
    refused(r, 400, 'A path no repo may have');
    assert.equal(r.json.path, path);
    refused(await patch({version: 1, set: {}, remove: [path]}), 400, 'A path no repo may have');
  }
  refused(await patch({version: 1, set: {}, remove: [42]}), 400, 'A path no repo may have');
  const tooMany = Object.fromEntries(Array.from({length: 5001}, (_, i) => [`f${i}`, null]));
  refused(await patch({version: 1, set: tooMany, remove: []}), 413, 'Too many changes at once');
  for (const bad of ['.hidden', 'a b', 'x'.repeat(65)]) refused(await s.call('PATCH', `/v1/repos/${encodeURIComponent(bad)}/draft`, {token: t, body: {version: 0, set: {}, remove: []}}), 404);
  refused(await s.call('PATCH', '/v1/repos/shape/draft?line=-x', {token: t, body: {version: 1, set: {}, remove: []}}), 404);
  // A version that is not the draft's says which it is.
  const stale = await patch({version: 7, set: {}, remove: []});
  assert.deepEqual([stale.status, stale.json], [409, {version: 1}]);
  const now = (await s.call('GET', '/v1/repos/shape', {token: t})).json as unknown as {version: number; draft: object};
  assert.deepEqual([now.version, now.draft], [1, {'a.txt': sha}]);
});

test('a commit: words of at most 2000 characters and a title; a parent that is not the head is refused, leaving no commit', async () => {
  const t = await s.person('Committer');
  assert.equal((await s.call('PATCH', '/v1/repos/c/draft', {token: t, body: {version: 0, set: {'a.txt': null}, remove: []}})).status, 200);
  const cut = (body: object) => s.call('POST', '/v1/repos/c/cuts', {token: t, body: {version: 1, parent: null, title: 't', ...body}});
  refused(await cut({title: '   '}), 400, 'A commit needs a title');
  refused(await cut({title: 'x'.repeat(2001)}), 400, 'Words of at most 2000 characters');
  refused(await cut({note: 'x'.repeat(2001)}), 400, 'Words of at most 2000 characters');
  refused(await cut({kind: 7}), 400, 'Words of at most 2000 characters');
  refused(await cut({parent: 'nope'}), 400, 'a cut');
  refused(await cut({version: 'one'}), 400, 'a cut');
  const wrongParent = await cut({parent: 'f'.repeat(64)});
  assert.deepEqual([wrongParent.status, wrongParent.json], [409, {head: null, version: 1}]);
  const ok = await cut({title: 'x'.repeat(2000), added: -5, removed: 2 ** 40});
  assert.equal(ok.status, 201, ok.text);
  const made = (await s.call('GET', `/v1/repos/c/cuts/${ok.json.id}`, {token: t})).json;
  // Counts that are no counts are kept as none.
  assert.deepEqual([made.added, made.removed], [0, 0]);
  // The same commit again (the head moved): refused, and the log has the one.
  refused(await cut({}), 409);
  assert.equal(((await s.call('GET', '/v1/repos/c/log', {token: t})).json as unknown[]).length, 1);
});

test('the log is read from the head along first parents, as many as asked and at most 200', async () => {
  const t = await s.person('Historian');
  assert.equal((await s.call('PATCH', '/v1/repos/long/draft', {token: t, body: {version: 0, set: {}, remove: []}})).status, 200);
  let parent: string | null = null;
  for (let i = 0; i < 5; i++) {
    const r = await s.call('POST', '/v1/repos/long/cuts', {token: t, body: {version: 1, parent, title: `c${i}`}});
    assert.equal(r.status, 201, r.text);
    parent = r.json.id as string;
  }
  const titles = async (q: string) => ((await s.call('GET', `/v1/repos/long/log${q}`, {token: t})).json as unknown as {title: string}[]).map((c) => c.title);
  assert.deepEqual(await titles(''), ['c4', 'c3', 'c2', 'c1', 'c0']);
  assert.deepEqual(await titles('?limit=2'), ['c4', 'c3']);
  assert.deepEqual(await titles('?limit=0'), ['c4', 'c3', 'c2', 'c1', 'c0']);
  assert.deepEqual(await titles('?limit=nonsense'), ['c4', 'c3', 'c2', 'c1', 'c0']);
  assert.deepEqual(await titles('?limit=-3'), ['c4']);
});

test('a setting: a short lowercase key, a value with its version; a stale version gets the current one back', async () => {
  const t = await s.person('Settler');
  const put = (key: string, body: unknown) => s.call('PUT', `/v1/home/${key}`, {token: t, body});
  for (const key of ['Todo', 'to-do', 'x'.repeat(33)]) refused(await put(key, {value: '[]', version: 0}), 404);
  refused(await put('todo', {value: [], version: 0}), 400, 'a value and its version');
  refused(await put('todo', {value: '[]'}), 400, 'a value and its version');
  assert.deepEqual((await put('todo', {value: '[1]', version: 0})).json, {version: 1});
  const stale = await put('todo', {value: '[2]', version: 0});
  assert.deepEqual([stale.status, stale.json], [409, {value: '[1]', version: 1}]);
  assert.deepEqual((await s.call('GET', '/v1/home/todo', {token: t})).json, {value: '[1]', version: 1});
});

// ---- a Remote that holds no files ----

test('with no bucket, each route that would move bytes says so, the same to everyone, and nothing else is refused', {skip: !!s.files}, async () => {
  const t = await s.person('Bucketless');
  const bytes = enc.encode('kept here\n');
  const sha = (await upload(s, t, bytes)).sha;
  const noFiles = {error: 'The Remote cannot hold files just now', files: false};
  const asks: [string, string, string | undefined][] = [['PUT', `/v1/blobs/${sha}`, t], ['GET', `/v1/blobs/${sha}`, t], ['GET', `/v1/os/${sha}`, undefined],
    ['HEAD', `/v1/os/${sha}`, undefined], ['GET', `/v1/seen/x@length3.test/notes/file?path=a`, undefined]];
  for (const [m, p, token] of asks) {
    const r = await s.call(m, p, {token, ...(m === 'PUT' ? {bytes} : {})});
    assert.equal(r.status, 503, `${m} ${p}`);
    if (m !== 'HEAD') assert.deepEqual(r.json, noFiles, `${m} ${p}`);
  }
  // What a client asks first is rows: which it lacks. A file never sent is missing; a draft naming it says so.
  const fresh = await sha256(enc.encode('never sent'));
  assert.deepEqual((await s.call('POST', '/v1/blobs/missing', {token: t, body: [sha, fresh]})).json, [fresh]);
  const named = await s.call('PATCH', '/v1/repos/nofiles/draft', {token: t, body: {version: 0, set: {'a.txt': fresh}, remove: []}});
  assert.deepEqual([named.status, named.json], [409, {missing: [fresh]}]);
  // Everything else is the Remote as ever: a draft of what it has, a commit, Home, the health of its database.
  assert.equal((await s.call('PATCH', '/v1/repos/nofiles/draft', {token: t, body: {version: 0, set: {'a.txt': sha, 'empty': null}, remove: []}})).status, 200);
  assert.equal((await s.call('POST', '/v1/repos/nofiles/cuts', {token: t, body: {version: 1, parent: null, title: 'kept'}})).status, 201);
  assert.equal((await s.call('PUT', '/v1/home/todo', {token: t, body: {value: '[]', version: 0}})).status, 200);
  assert.deepEqual((await s.call('GET', '/v1/health')).json, {ok: true});
  // The sweep lets no blob go while there is no bucket to take its bytes from: one no tree names stays.
  const me = await idOf(s, t);
  await upload(s, t, enc.encode('named by nothing'));
  await s.db.execute(sql`update blob set created_at = now() - interval '2 days' where user_id = ${me}`);
  assert.equal((await sweep(s.db, s.files)).blob, undefined);
  assert.equal(await count(s, sql`select count(*)::int as n from blob where user_id = ${me}`), 2);
});
