import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {remote, type Ran} from './harness.ts';

// l3 end to end, against a Remote of its own (service/dev.ts on a free
// port, its data in a directory made for it): real commands, their words,
// their exit codes, and what the Remote holds after. Each test has repos
// and people of its own; the devices signed in here are shared, and none
// depends on another test having run. One stops the Remote and starts it
// again (same port, same data), to be a device out of its reach meanwhile.
//
//   npm run selftest:l3   (builds l3; L3=path/to/l3 takes that one instead)

const r = await remote();
const ren = await r.browser('Ren Selftest');
/** Ren's laptop and Ren's other machine: two devices on one account. */
const laptop = r.device(), desk = r.device();
for (const d of [laptop, desk]) assert.equal((await d.login(ren)).code, 0);

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
/** The draft the Remote holds for one of Ren's repos. */
const draftOf = async (repo: string) => (await r.api(ren, 'GET', `/v1/repos/${repo}`)).json as {version: number; head: string | null; draft: Record<string, string | null>};
/** A file's text as the Remote holds it in one of Ren's repos. */
const textOf = async (repo: string, path: string) => (await r.api(ren, 'GET', `/v1/blobs/${(await draftOf(repo)).draft[path]}`)).text;
/** l3 ran and said it was done: exit 0, nothing on standard error. */
function ok(x: Ran, says?: RegExp): Ran {
  assert.equal(x.code, 0, `${x.out}${x.err}`);
  assert.equal(x.err, '');
  if (says) assert.match(x.out, says);
  return x;
}
/** l3 refused, with this exit code and these words on standard error, and nothing on standard output. */
function refused(x: Ran, code: number, says: RegExp) {
  assert.equal(x.code, code, `${x.out}${x.err}`);
  assert.match(x.err, says);
  assert.equal(x.out, '');
}

test('l3 login connects a device through the Remote\'s approval in a browser; l3 remote then names the account', async () => {
  const fresh = r.device();
  const done = await fresh.login(ren);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /Open this page in a browser and approve:\n {2}http:\/\/localhost:4173\/\?device=&user_code=\w+\n {2}code \w+\n/);
  assert.match(done.out, new RegExp(`Signed in · ${r.url.replace('http://', '').replace(/\./g, '\\.')}`));
  const remote = ok(fresh.l3(['remote', '--json'])).json;
  assert.deepEqual([remote.url, remote.account.name], [r.url, 'Ren Selftest']);
  // Each device is a session of its own, listed with this one marked.
  const devices = ok(fresh.l3(['remote', 'devices', '--json'])).json as {current: boolean}[];
  assert.ok(devices.length >= 3 && devices.filter((d) => d.current).length === 1, JSON.stringify(devices));
  ok(fresh.l3(['logout']), /this device is signed out/);
  assert.equal(ok(fresh.l3(['remote', '--json'])).json.url, null);
});

test('a repo made and written with l3 is on the Remote byte for byte, CRLF, names beyond ASCII and all', async () => {
  ok(laptop.l3(['repo', 'new', 'files', '-t', 'empty']), /^Made files \(empty · 1 file\)\n$/);
  const text = '一行目\r\n二行目\r\n';
  ok(laptop.l3(['file', 'write', 'files/ノート/メモ.md'], text), /^Made files\/ノート\/メモ\.md \(22 B\)\n$/);
  assert.equal(ok(laptop.l3(['file', 'files/ノート/メモ.md'])).out, text);
  ok(laptop.l3(['file', 'write', 'files/ノート/メモ.md'], 'changed\n'), /^Saved /);
  // Empty standard input writes nothing, unless asked.
  refused(laptop.l3(['file', 'write', 'files/empty.txt'], ''), 1, /Standard input was empty, so nothing was written/);
  ok(laptop.l3(['file', 'write', 'files/empty.txt', '--empty'], ''), /\(0 B\)/);
  const there = await draftOf('files');
  assert.equal(there.draft['ノート/メモ.md'], sha('changed\n'));
  assert.equal(there.draft['empty.txt'], sha(''));
  ok(laptop.l3(['file', 'rm', 'files/ノート']));
  assert.equal((await draftOf('files')).draft['ノート/メモ.md'], undefined);
});

test('another device opens the repo from the Remote, and takes in each change made on the first when it reads', async () => {
  ok(laptop.l3(['repo', 'new', 'shared', '-t', 'empty']));
  ok(laptop.l3(['file', 'write', 'shared/a.txt'], 'one\n'));
  assert.match(ok(desk.l3(['repo'])).out, /shared\tonly on the Remote/);
  ok(desk.l3(['repo', 'open', 'shared']), /^shared is here now/);
  assert.equal(ok(desk.l3(['file', 'shared/a.txt'])).out, 'one\n');
  ok(laptop.l3(['file', 'write', 'shared/a.txt'], 'two\n'));
  assert.equal(ok(desk.l3(['file', 'shared/a.txt'])).out, 'two\n');
  // And back: the desk's change reaches the laptop.
  ok(desk.l3(['file', 'write', 'shared/b.txt'], 'from the desk\n'));
  assert.equal(ok(laptop.l3(['file', 'shared/b.txt'])).out, 'from the desk\n');
  assert.match(ok(laptop.l3(['remote'])).out, /\n {2}shared {2}in step/);
});

test('an issue goes from written to merged with l3: start, commit, push, review, merge; the Remote holds each step', async () => {
  ok(laptop.l3(['repo', 'new', 'work']));
  ok(laptop.l3(['issue', 'new', 'work', 'Fix：落ちる', '-m', '再現手順']), /^Wrote work#1 Fix：落ちる\n$/);
  assert.match(ok(laptop.l3(['git', 'work'])).out, /#1 Fix：落ちる\n {4}work · not started\n {4}next: l3 start work#1/);
  ok(laptop.l3(['commit', 'work', 'Patch：はじめ']), /^Committed [0-9a-f]{12} {2}Patch：はじめ/);
  ok(laptop.l3(['start', 'work#1']), /^Working on work#1 Fix：落ちる/);
  ok(laptop.l3(['file', 'write', 'work/fix.txt'], 'fixed\n'));
  ok(laptop.l3(['commit', 'work']), /^Committed [0-9a-f]{12} {2}Fix：落ちる \(1 file \+1 −0\)/);
  ok(laptop.l3(['push', 'work']), /handed Fix：落ちる to main as version 1/);
  const change = ((await r.api(ren, 'GET', '/v1/repos/work/changes')).json as {state: string; version: number; issue: string}[])[0];
  assert.deepEqual([change.state, change.version, change.issue], ['open', 1, 'issue/001.md']);
  // main does not have the fix until it is merged.
  assert.equal((await draftOf('work')).draft['fix.txt'], undefined);
  ok(laptop.l3(['review', 'work#1', 'approve', '-m', 'good']), /^Approved version 1 of Fix：落ちる/);
  ok(laptop.l3(['merge', 'work#1']), /^Merged Fix：落ちる into main \(version 1\)/);
  assert.equal(((await r.api(ren, 'GET', '/v1/repos/work/changes')).json as {state: string}[])[0].state, 'merged');
  assert.equal((await draftOf('work')).draft['fix.txt'], sha('fixed\n'));
  const log = ok(laptop.l3(['log', 'work', '--json'])).json as {title: string; kind: string}[];
  assert.deepEqual(log.map((c) => `${c.kind}：${c.title}`).slice(-1), ['Patch：はじめ']);
  refused(laptop.l3(['issue', 'work#9']), 4, /work has no issue #9/);
});

test('TODO: add, list, done and undone, remove; a number not in the list is not found', async () => {
  const home = r.device();
  ok(home.l3(['todo']), /No TODO yet/);
  ok(home.l3(['todo', 'add', 'Fix：牛乳', '-m', '二本']), /^Added to TODO: Fix：牛乳 \(1 open\)\n$/);
  ok(home.l3(['todo', 'add', '電話する']), /\(2 open\)/);
  const list = ok(home.l3(['todo', '--json'])).json as {id: string; kind: string | null; title: string; detail: string; done: boolean}[];
  assert.deepEqual(list.map((t) => [t.kind, t.title, t.detail, t.done]), [['Fix', '牛乳', '二本', false], [null, '電話する', '', false]]);
  assert.notEqual(list[0].id, list[1].id);
  assert.equal(ok(home.l3(['todo'])).out, '  1 ○ Fix：牛乳\n        二本\n  2 ○ 電話する\n');
  ok(home.l3(['todo', 'done', '1']), /^Done: Fix：牛乳/);
  ok(home.l3(['todo', 'done', '1']), /^Not done again: Fix：牛乳/);
  ok(home.l3(['todo', 'rm', '2']));
  refused(home.l3(['todo', 'rm', '2']), 4, /There is no TODO number 2 \(1 to 1\)/);
  refused(home.l3(['todo', 'done', 'x']), 2, /Not how l3 todo done x is written/);
  refused(home.l3(['todo', 'add', '']), 2, /The TODO's first line is empty/);
  assert.equal((ok(home.l3(['todo', '--json'])).json as unknown[]).length, 1);
});

test('TODO changed on two devices, one away from the Remote meanwhile: what each changed is kept, as the app joins them', async () => {
  const kai = await r.browser('Kai Selftest');
  const one = r.device(), two = r.device();
  for (const d of [one, two]) assert.equal((await d.login(kai)).code, 0);
  const list = (d: typeof one) => (ok(d.l3(['todo', '--json'])).json as {title: string; done: boolean}[]).map((t) => [t.title, t.done]);
  ok(one.l3(['todo', 'add', '牛乳']));
  ok(one.l3(['todo', 'add', '電話する']));
  assert.deepEqual(list(two), [['牛乳', false], ['電話する', false]]);
  // The second device writes one while the Remote is out of reach: it is kept there, and l3 says so once.
  await r.stop();
  const away = two.l3(['todo', 'add', '手紙']);
  assert.equal(away.code, 0, away.err);
  assert.match(away.out, /^Added to TODO: 手紙 \(3 open\)\n$/);
  assert.equal(away.err.match(/Home's TODO is not in step with the Remote yet/g)?.length, 1, away.err);
  await r.start();
  // Meanwhile the first marks one done and removes the other.
  ok(one.l3(['todo', 'done', '1']));
  ok(one.l3(['todo', 'rm', '2']));
  // Back in reach, the second takes in both and sends its own; the first then has the same.
  const want = [['牛乳', true], ['手紙', false]];
  assert.deepEqual(list(two), want);
  assert.deepEqual(list(one), want);
  const there = (await r.api(kai, 'GET', '/v1/home/todo')).json as {value: string};
  assert.deepEqual((JSON.parse(there.value) as {title: string; done: boolean}[]).map((t) => [t.title, t.done]), want);
});

test('an issue that will not be done is closed in its own file, on the Remote too; another device reopens it', async () => {
  ok(laptop.l3(['repo', 'new', 'tasks', '-t', 'empty']));
  ok(laptop.l3(['issue', 'new', 'tasks', 'Fix：やらない', '-m', '理由']), /^Wrote tasks#1 Fix：やらない\n$/);
  ok(laptop.l3(['issue', 'close', 'tasks#1']), /^Closed tasks#1; it will not be done \(back with: l3 issue reopen tasks#1\)\n$/);
  ok(laptop.l3(['issue', 'close', 'tasks#1']), /^tasks#1 is closed already\n$/);
  assert.match(await textOf('tasks', 'issue/001.md'), /^Fix：やらない\n\n理由\n\nClosed：\d{4}-\d{2}-\d{2}( .+)?\n$/);
  const git = ok(laptop.l3(['git', 'tasks', '--json'])).json as {closed: {repo: string; issues: string[]}[]};
  assert.deepEqual(git.closed.map((c) => [c.repo, c.issues.length]), [['tasks', 1]]);
  assert.match(ok(laptop.l3(['issue', 'tasks#1'])).out, /closed \d{4}-\d{2}-\d{2}/);
  ok(desk.l3(['repo', 'open', 'tasks']));
  ok(desk.l3(['issue', 'reopen', 'tasks#1']), /^Reopened tasks#1\n$/);
  assert.equal(await textOf('tasks', 'issue/001.md'), 'Fix：やらない\n\n理由\n');
  assert.deepEqual((ok(laptop.l3(['git', 'tasks', '--json'])).json as {closed: unknown[]}).closed, []);
});

test('l3 name answers with the name alone, l3 name list with its term; l3 address, off a terminal with SSH off, says so with 5', async () => {
  const sora = await r.browser('Sora Selftest');
  const d = r.device();
  assert.equal((await d.login(sora)).code, 0);
  refused(d.l3(['name']), 4, /No name yet \(l3 name claim NAME\)/);
  ok(d.l3(['name', 'claim', 'soraself']), /^Yours: soraself@length3\.test\n$/);
  assert.equal(ok(d.l3(['name'])).out, 'soraself@length3.test\n');
  // In the list a name on the Remote's own domain is said without it.
  assert.match(ok(d.l3(['name', 'list'])).out, /^soraself  · until \d{4}-\d{2}-\d{2}\nYour code: \d{6} /);
  // A name of someone else's is not one of yours.
  refused(d.l3(['name', 'renew', 'renself']), 4, /is not one of your names/);
  // SSH is this device's (service/ssh.ts): off at first, and a script is told, never asked.
  refused(d.l3(['address']), 5, /SSH is off on this device/);
});

test('Inbox: a request to someone who has not accepted, their answer, and a block that stops them', async () => {
  const mio = await r.browser('Mio Selftest');
  ok(laptop.l3(['name', 'claim', 'renself']), /^Yours: renself@length3\.test\n$/);
  assert.equal((await r.api(mio, 'POST', '/v1/inbox/addresses', {name: 'mioself'})).status, 201);
  ok(laptop.l3(['inbox', 'send', 'mioself', 'Review：見てください /root/shared/a.txt']), /^Sent to mioself@length3\.test as a request/);
  const threads = (await r.api(mio, 'GET', '/v1/inbox/threads')).json as {address: string; state: string; last: {type: string; body: string}}[];
  assert.deepEqual(threads.map((t) => [t.address, t.state, t.last.type]), [['renself@length3.test', 'request', 'review']]);
  // Ren wrote first, so Mio's answer is no request.
  assert.equal((await r.api(mio, 'POST', '/v1/inbox/messages', {to: 'renself', body: 'はい\u001b[2J'})).json.request, false);
  const said = ok(laptop.l3(['inbox', 'mioself'])).out;
  assert.match(said, /you · Review request · 見てください \/root\/shared\/a\.txt/);
  // What another wrote is shown without its control characters.
  assert.match(said, /mioself · はい�\[2J/);
  ok(laptop.l3(['inbox', 'block', 'mioself']), /^Blocked mioself@length3\.test/);
  assert.equal((await r.api(mio, 'POST', '/v1/inbox/messages', {to: 'renself', body: 'again'})).status, 403);
  refused(laptop.l3(['inbox', 'send', 'nobody-here', 'hi']), 1, /No one has that (address|name)/);
});

test('what l3 cannot do has its exit code: how it is written (2), no Remote (3), not there (4), refused (1)', async () => {
  const away = r.device();
  refused(away.l3(['frobnicate']), 2, /Not a command: l3 frobnicate/);
  refused(away.l3(['log', 'files']), 3, /l3 log needs the Remote, and this device is not signed in to one \(l3 login\)/);
  refused(away.l3(['repo', 'open', 'files']), 3, /needs the Remote/);
  refused(away.l3(['file', 'nope/x']), 4, /There is no repo nope here/);
  refused(away.l3(['issue', 'new', 'nope', 'x']), 4, /There is no repo nope here/);
  refused(away.l3(['repo', 'new', '.bad']), 2, /is not a repo name/);
  ok(away.l3(['repo', 'new', 'mine', '-t', 'empty']));
  refused(away.l3(['repo', 'new', 'mine']), 1, /There is a repo mine already/);
  refused(away.l3(['file', 'write', 'mine/.git/config'], 'x'), 1, /is in the repo's \.git/);
  refused(away.l3(['file', 'write', 'mine/../x'], 'x'), 1, /leaves the repo/);
  // With --json a refusal is data on standard output: its kind and its words.
  const j = away.l3(['file', 'nope/x', '--json']);
  assert.deepEqual([j.code, j.json], [4, {error: {kind: 'notFound', message: 'There is no repo nope here'}}]);
});
