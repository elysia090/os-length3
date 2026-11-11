import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, existsSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {remote, type Ran} from './harness.ts';

// root3 end to end, against a Remote of its own (root3/remote/serve/dev.ts on a free
// port, its data in a directory made for it): real commands, their words,
// their exit codes, and what the Remote holds after. Each test has repos
// and people of its own; the devices signed in here are shared, and none
// depends on another test having run. One stops the Remote and starts it
// again (same port, same data), to be a device out of its reach meanwhile.
//
//   npm run selftest:cli   (builds root3; ROOT3=path/to/root3 takes that one instead)

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
/** root3 ran and said it was done: exit 0, nothing on standard error. */
function ok(x: Ran, says?: RegExp): Ran {
  assert.equal(x.code, 0, `${x.out}${x.err}`);
  assert.equal(x.err, '');
  if (says) assert.match(x.out, says);
  return x;
}
/** root3 refused, with this exit code and these words on standard error, and nothing on standard output. */
function refused(x: Ran, code: number, says: RegExp) {
  assert.equal(x.code, code, `${x.out}${x.err}`);
  assert.match(x.err, says);
  assert.equal(x.out, '');
}

test('root3 login connects a device through the Remote\'s approval in a browser; root3 remote then names the account', async () => {
  const fresh = r.device();
  const done = await fresh.login(ren);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, new RegExp(`Open this page in a browser and approve:\n {2}${r.app.replace(/[./]/g, '\\$&')}/\\?device=&user_code=\\w+\n {2}code \\w+\n`));
  assert.match(done.out, new RegExp(`Signed in · ${r.url.replace('http://', '').replace(/\./g, '\\.')}`));
  const remote = ok(fresh.root3(['remote', '--json'])).json;
  assert.deepEqual([remote.url, remote.account.name], [r.url, 'Ren Selftest']);
  // Each device is a session of its own, listed with this one marked.
  const devices = ok(fresh.root3(['remote', 'devices', '--json'])).json as {current: boolean}[];
  assert.ok(devices.length >= 3 && devices.filter((d) => d.current).length === 1, JSON.stringify(devices));
  ok(fresh.root3(['logout']), /this device is signed out/);
  assert.equal(ok(fresh.root3(['remote', '--json'])).json.url, null);
});

test('a repo made and written with root3 is on the Remote byte for byte, CRLF, names beyond ASCII and all', async () => {
  ok(laptop.root3(['repo', 'new', 'files', '-t', 'empty']), /^Made files \(empty · 1 file\)\n$/);
  const text = '一行目\r\n二行目\r\n';
  ok(laptop.root3(['file', 'write', 'files/ノート/メモ.md'], text), /^Made files\/ノート\/メモ\.md \(22 B\)\n$/);
  assert.equal(ok(laptop.root3(['file', 'files/ノート/メモ.md'])).out, text);
  ok(laptop.root3(['file', 'write', 'files/ノート/メモ.md'], 'changed\n'), /^Saved /);
  // Empty standard input writes nothing, unless asked.
  refused(laptop.root3(['file', 'write', 'files/empty.txt'], ''), 1, /Standard input was empty, so nothing was written/);
  ok(laptop.root3(['file', 'write', 'files/empty.txt', '--empty'], ''), /\(0 B\)/);
  const there = await draftOf('files');
  assert.equal(there.draft['ノート/メモ.md'], sha('changed\n'));
  assert.equal(there.draft['empty.txt'], sha(''));
  ok(laptop.root3(['file', 'rm', 'files/ノート']));
  assert.equal((await draftOf('files')).draft['ノート/メモ.md'], undefined);
});

test('a file holding a key stays on this device: the Remote never has it, root3 remote and Commit say so, and taken out it goes', async () => {
  ok(laptop.root3(['repo', 'new', 'keyed', '-t', 'empty']));
  const key = `sk-ant-api03-${'x'.repeat(91)}k9AA`;
  ok(laptop.root3(['file', 'write', 'keyed/.env'], `ANTHROPIC_API_KEY=${key}\n`));
  ok(laptop.root3(['file', 'write', 'keyed/notes.md'], 'plain\n'));
  // What holds none goes as ever; the key's file does not, nor is anything of it removed there.
  const there = await draftOf('keyed');
  assert.equal(there.draft['notes.md'], sha('plain\n'));
  assert.equal(there.draft['.env'], undefined);
  // In step otherwise: the key's file is not a change waiting to go, it is one that cannot.
  assert.match(ok(laptop.root3(['remote'])).out, /\n {2}keyed {2,}in step · 1 cannot be sent\n/);
  const row = (ok(laptop.root3(['remote', '--json'])).json.here as {name: string; unsendable: string[]}[]).find((x) => x.name === 'keyed');
  assert.deepEqual(row?.unsendable, ['.env']);
  refused(laptop.root3(['commit', 'keyed', 'Patch：keys']), 1, /\(\.env: secret sk-ant-…k9AA\)/);
  // Never the key whole, in anything said.
  assert.doesNotMatch(JSON.stringify(ok(laptop.root3(['remote', '--json'])).json), /x{20}/);
  ok(laptop.root3(['file', 'write', 'keyed/.env'], 'ANTHROPIC_API_KEY=\n'));
  assert.equal((await draftOf('keyed')).draft['.env'], sha('ANTHROPIC_API_KEY=\n'));
});

test('root3 repo mv and rm do what the repo\'s gear does: one only this device has is renamed and deleted, one on the Remote is not', async () => {
  const alone = r.device();
  ok(alone.root3(['repo', 'new', 'draft', '-t', 'empty']));
  ok(alone.root3(['repo', 'mv', 'draft', 'notes']), /^Renamed draft to notes\n$/);
  assert.match(ok(alone.root3(['repo'])).out, /^notes /m);
  ok(alone.root3(['repo', 'rm', 'notes']), /^Deleted notes from this device\n$/);
  assert.doesNotMatch(ok(alone.root3(['repo'])).out, /notes/);
  // On the Remote, which knows it by its name and guards it with a passkey: said where it is done, nothing done here.
  ok(laptop.root3(['repo', 'new', 'kept', '-t', 'empty']));
  refused(laptop.root3(['repo', 'mv', 'kept', 'other']), 1, /kept is on the Remote/);
  refused(laptop.root3(['repo', 'rm', 'kept']), 1, /kept is on the Remote: turn it off there first/);
  assert.match(ok(laptop.root3(['repo'])).out, /^kept /m);
});

test('another device opens the repo from the Remote, and takes in each change made on the first when it reads', async () => {
  ok(laptop.root3(['repo', 'new', 'shared', '-t', 'empty']));
  ok(laptop.root3(['file', 'write', 'shared/a.txt'], 'one\n'));
  assert.match(ok(desk.root3(['repo'])).out, /^shared {2,}only on the Remote/m);
  ok(desk.root3(['repo', 'open', 'shared']), /^shared is here now/);
  assert.equal(ok(desk.root3(['file', 'shared/a.txt'])).out, 'one\n');
  ok(laptop.root3(['file', 'write', 'shared/a.txt'], 'two\n'));
  assert.equal(ok(desk.root3(['file', 'shared/a.txt'])).out, 'two\n');
  // And back: the desk's change reaches the laptop.
  ok(desk.root3(['file', 'write', 'shared/b.txt'], 'from the desk\n'));
  assert.equal(ok(laptop.root3(['file', 'shared/b.txt'])).out, 'from the desk\n');
  assert.match(ok(laptop.root3(['remote'])).out, /\n {2}shared {2,}in step/);
});

test('a script\'s execute bit goes to the Remote and comes back with it: opened on another device, after a change, and after Free and opening again', async () => {
  const at = (d: {home: string}, path: string) => join(d.home, 'length3', 'repos', path);
  const mode = (d: {home: string}, path: string) => statSync(at(d, path)).mode & 0o777;
  const runs = (d: {home: string}, path: string) => spawnSync(at(d, path), [], {encoding: 'utf8'});
  ok(laptop.root3(['repo', 'new', 'scripts', '-t', 'empty']));
  ok(laptop.root3(['file', 'write', 'scripts/run.sh'], '#!/bin/sh\necho ran one\n'));
  chmodSync(at(laptop, 'scripts/run.sh'), 0o755);
  // A mode alone is a change: it is sent (root3 repo sends what changed before it lists).
  ok(laptop.root3(['repo']));
  assert.deepEqual((await r.api(ren, 'GET', '/v1/repos/scripts')).json.modes, {'run.sh': 0o755});
  ok(desk.root3(['repo', 'open', 'scripts']));
  assert.equal(mode(desk, 'scripts/run.sh'), 0o755);
  assert.equal(runs(desk, 'scripts/run.sh').stdout, 'ran one\n');
  // Changed on the laptop: the desk takes the new bytes, and the bit stays.
  ok(laptop.root3(['file', 'write', 'scripts/run.sh'], '#!/bin/sh\necho ran two\n'));
  assert.equal(mode(laptop, 'scripts/run.sh'), 0o755);
  ok(desk.root3(['file', 'scripts/run.sh']));
  assert.equal(mode(desk, 'scripts/run.sh'), 0o755);
  assert.equal(runs(desk, 'scripts/run.sh').stdout, 'ran two\n');
  // Freed on the desk and opened again: as it was.
  ok(desk.root3(['free', 'scripts']));
  assert.ok(!existsSync(at(desk, 'scripts')));
  ok(desk.root3(['repo', 'open', 'scripts']));
  assert.equal(mode(desk, 'scripts/run.sh'), 0o755);
  assert.equal(runs(desk, 'scripts/run.sh').stdout, 'ran two\n');
  // Taken off on the laptop: a plain file on the desk too.
  chmodSync(at(laptop, 'scripts/run.sh'), 0o644);
  ok(laptop.root3(['repo']));
  ok(desk.root3(['file', 'scripts/run.sh']));
  assert.equal(mode(desk, 'scripts/run.sh') & 0o111, 0);
});

test('an issue goes from written to merged with root3: start, commit (handed in by itself), review, merge; the Remote holds each step', async () => {
  ok(laptop.root3(['repo', 'new', 'work']));
  ok(laptop.root3(['issue', 'new', 'work', 'Fix：落ちる', '-m', '再現手順']), /^Wrote work#1 Fix：落ちる\n$/);
  // The issue is history on main at once, by itself, after what the repo was made with (its first commit, Start).
  const first = ((await r.api(ren, 'GET', '/v1/repos/work/log?summary=1')).json as {title: string; files: number}[]).map((c) => [c.title, c.files]);
  assert.deepEqual(first.map(([t]) => t), ['Issue #1: Fix：落ちる', 'Start']);
  assert.equal(first[0][1], 1);
  assert.match(ok(laptop.root3(['git', 'work'])).out, /#1 Fix：落ちる\n {4}work · not started\n {4}next: root3 start work#1/);
  // What the person writes on main is theirs to commit, by itself.
  ok(laptop.root3(['file', 'write', 'work/notes.txt'], 'notes\n'));
  ok(laptop.root3(['commit', 'work', 'Patch：はじめ']), /^Committed [0-9a-f]{12} {2}Patch：はじめ \(1 file/);
  ok(laptop.root3(['start', 'work#1']), /^Working on work#1 Fix：落ちる/);
  ok(laptop.root3(['file', 'write', 'work/fix.txt'], 'fixed\n'));
  // On an issue's work a commit is handed in as it is made: there is nothing left to submit.
  ok(laptop.root3(['commit', 'work']), /^Committed [0-9a-f]{12} {2}Fix：落ちる \(1 file \+1 −0\)\n {2}handed to main as version 1\n$/);
  ok(laptop.root3(['submit', 'work']), /^Nothing new to submit: version 1 of Fix：落ちる is with main already\n$/);
  const change = ((await r.api(ren, 'GET', '/v1/repos/work/changes')).json as {state: string; version: number; issue: string}[])[0];
  assert.deepEqual([change.state, change.version, change.issue], ['open', 1, 'issue/001.md']);
  // main does not have the fix until it is merged.
  assert.equal((await draftOf('work')).draft['fix.txt'], undefined);
  ok(laptop.root3(['review', 'work#1', 'approve', '-m', 'good']), /^Approved version 1 of Fix：落ちる/);
  ok(laptop.root3(['merge', 'work#1']), /^Merged Fix：落ちる into main \(version 1\)/);
  assert.equal(((await r.api(ren, 'GET', '/v1/repos/work/changes')).json as {state: string}[])[0].state, 'merged');
  assert.equal((await draftOf('work')).draft['fix.txt'], sha('fixed\n'));
  const log = ok(laptop.root3(['log', 'work', '--json'])).json as {title: string; kind: string}[];
  assert.deepEqual(log.map((c) => (c.kind ? `${c.kind}：${c.title}` : c.title)).slice(-3), ['Patch：はじめ', 'Issue #1: Fix：落ちる', 'Start']);
  refused(laptop.root3(['issue', 'work#9']), 4, /work has no issue #9/);
});

test('TODO: add, list, done and undone, remove; a number not in the list is not found', async () => {
  const home = r.device();
  ok(home.root3(['todo']), /No TODO yet/);
  ok(home.root3(['todo', 'add', 'Fix：牛乳', '-m', '二本']), /^Added to TODO: Fix：牛乳 \(1 open\)\n$/);
  ok(home.root3(['todo', 'add', '電話する']), /\(2 open\)/);
  const list = ok(home.root3(['todo', '--json'])).json as {id: string; kind: string | null; title: string; detail: string; done: boolean}[];
  assert.deepEqual(list.map((t) => [t.kind, t.title, t.detail, t.done]), [['Fix', '牛乳', '二本', false], [null, '電話する', '', false]]);
  assert.notEqual(list[0].id, list[1].id);
  assert.equal(ok(home.root3(['todo'])).out, '  1 ○ Fix：牛乳\n        二本\n  2 ○ 電話する\n');
  ok(home.root3(['todo', 'done', '1']), /^Done: Fix：牛乳/);
  ok(home.root3(['todo', 'done', '1']), /^Not done again: Fix：牛乳/);
  ok(home.root3(['todo', 'rm', '2']));
  refused(home.root3(['todo', 'rm', '2']), 4, /There is no TODO number 2 \(1 to 1\)/);
  refused(home.root3(['todo', 'done', 'x']), 2, /Not how root3 todo done x is written/);
  refused(home.root3(['todo', 'add', '']), 2, /The TODO's first line is empty/);
  assert.equal((ok(home.root3(['todo', '--json'])).json as unknown[]).length, 1);
});

test('TODO changed on two devices, one away from the Remote meanwhile: what each changed is kept, as the app joins them', async () => {
  const kai = await r.browser('Kai Selftest');
  const one = r.device(), two = r.device();
  for (const d of [one, two]) assert.equal((await d.login(kai)).code, 0);
  const list = (d: typeof one) => (ok(d.root3(['todo', '--json'])).json as {title: string; done: boolean}[]).map((t) => [t.title, t.done]);
  ok(one.root3(['todo', 'add', '牛乳']));
  ok(one.root3(['todo', 'add', '電話する']));
  assert.deepEqual(list(two), [['牛乳', false], ['電話する', false]]);
  // The second device writes one while the Remote is out of reach: it is kept there, and root3 says so once.
  await r.stop();
  const away = two.root3(['todo', 'add', '手紙']);
  assert.equal(away.code, 0, away.err);
  assert.match(away.out, /^Added to TODO: 手紙 \(3 open\)\n$/);
  assert.equal(away.err.match(/Home's TODO is not in step with the Remote yet/g)?.length, 1, away.err);
  await r.start();
  // Meanwhile the first marks one done and removes the other.
  ok(one.root3(['todo', 'done', '1']));
  ok(one.root3(['todo', 'rm', '2']));
  // Back in reach, the second takes in both and sends its own; the first then has the same.
  const want = [['牛乳', true], ['手紙', false]];
  assert.deepEqual(list(two), want);
  assert.deepEqual(list(one), want);
  const there = (await r.api(kai, 'GET', '/v1/home/todo')).json as {value: string};
  assert.deepEqual((JSON.parse(there.value) as {title: string; done: boolean}[]).map((t) => [t.title, t.done]), want);
});

test('an issue that will not be done is closed in its own file, on the Remote too; another device reopens it', async () => {
  ok(laptop.root3(['repo', 'new', 'tasks', '-t', 'empty']));
  ok(laptop.root3(['issue', 'new', 'tasks', 'Fix：やらない', '-m', '理由']), /^Wrote tasks#1 Fix：やらない\n$/);
  ok(laptop.root3(['issue', 'close', 'tasks#1']), /^Closed tasks#1; it will not be done \(back with: root3 issue reopen tasks#1\)\n$/);
  ok(laptop.root3(['issue', 'close', 'tasks#1']), /^tasks#1 is closed already\n$/);
  assert.match(await textOf('tasks', 'issue/001.md'), /^Fix：やらない\n\n理由\n\nClosed：\d{4}-\d{2}-\d{2}( .+)?\n$/);
  const git = ok(laptop.root3(['git', 'tasks', '--json'])).json as {closed: {repo: string; issues: string[]}[]};
  assert.deepEqual(git.closed.map((c) => [c.repo, c.issues.length]), [['tasks', 1]]);
  assert.match(ok(laptop.root3(['issue', 'tasks#1'])).out, /closed \d{4}-\d{2}-\d{2}/);
  ok(desk.root3(['repo', 'open', 'tasks']));
  ok(desk.root3(['issue', 'reopen', 'tasks#1']), /^Reopened tasks#1\n$/);
  assert.equal(await textOf('tasks', 'issue/001.md'), 'Fix：やらない\n\n理由\n');
  assert.deepEqual((ok(laptop.root3(['git', 'tasks', '--json'])).json as {closed: unknown[]}).closed, []);
  // Each was history on main by itself as it happened: written, closed, reopened (from either device), after what
  // the repo was made with.
  const log = ((await r.api(ren, 'GET', '/v1/repos/tasks/log?summary=1')).json as {title: string; files: number}[]).map((c) => [c.title, c.files]);
  assert.deepEqual(log.map(([t]) => t), ['Reopen #1: Fix：やらない', 'Close #1: Fix：やらない', 'Issue #1: Fix：やらない', 'Start']);
  assert.deepEqual(log.slice(0, 3).map(([, n]) => n), [1, 1, 1]);
});

test('root3 name answers with the username alone, given at sign-in; root3 name set changes it; root3 name ls with the code; root3 address, off a terminal with SSH off, says so with 5', async () => {
  const sora = await r.browser('Sora Selftest');
  const d = r.device();
  assert.equal((await d.login(sora)).code, 0);
  assert.equal(ok(d.root3(['name'])).out, 'sora-selftest@length3.test\n');
  ok(d.root3(['name', 'set', '@soraself']), /^Your username: soraself \(the one before is held for you 30 days\)\n$/);
  assert.equal(ok(d.root3(['name'])).out, 'soraself@length3.test\n');
  // In the list a name on the Remote's own domain is said without it.
  assert.match(ok(d.root3(['name', 'ls'])).out, /^soraself\nYour code: \d{6} /);
  // As every list is asked for (ls); list, as it was, still answers.
  assert.match(ok(d.root3(['name', 'list'])).out, /^soraself\n/);
  // SSH is this device's (root3/remote/repos/ssh.ts): off at first, and a script is told, never asked.
  refused(d.root3(['address']), 5, /SSH is off on this device/);
});

test('Inbox: a request to someone who has not accepted, their answer, and a block that stops them', async () => {
  const mio = await r.browser('Mio Selftest');
  ok(laptop.root3(['name', 'set', 'renself']), /^Your username: renself /);
  assert.equal((await r.api(mio, 'PUT', '/v1/inbox/username', {name: 'mioself'})).status, 200);
  ok(laptop.root3(['inbox', 'send', 'mioself', 'Review：見てください /root/shared/a.txt']), /^Sent to mioself@length3\.test as a request/);
  const threads = (await r.api(mio, 'GET', '/v1/inbox/threads')).json as {address: string; state: string; last: {type: string; body: string}}[];
  assert.deepEqual(threads.map((t) => [t.address, t.state, t.last.type]), [['renself@length3.test', 'request', 'review']]);
  // Ren wrote first, so Mio's answer is no request.
  assert.equal((await r.api(mio, 'POST', '/v1/inbox/messages', {to: 'renself', body: 'はい\u001b[2J'})).json.request, false);
  const said = ok(laptop.root3(['inbox', 'mioself'])).out;
  assert.match(said, /you · Review request · 見てください \/root\/shared\/a\.txt/);
  // What another wrote is shown without its control characters.
  assert.match(said, /mioself · はい�\[2J/);
  ok(laptop.root3(['inbox', 'block', 'mioself']), /^Blocked mioself@length3\.test/);
  assert.equal((await r.api(mio, 'POST', '/v1/inbox/messages', {to: 'renself', body: 'again'})).status, 403);
  refused(laptop.root3(['inbox', 'send', 'nobody-here', 'hi']), 1, /No user found with that (address|name)/);
});

test('what root3 cannot do has its exit code: how it is written (2), no Remote (3), not there (4), refused (1)', async () => {
  const away = r.device();
  refused(away.root3(['frobnicate']), 2, /Not a command: root3 frobnicate/);
  refused(away.root3(['log', 'files']), 3, /root3 log needs the Remote, and this device is not signed in to one \(root3 login\)/);
  refused(away.root3(['repo', 'open', 'files']), 3, /needs the Remote/);
  refused(away.root3(['file', 'nope/x']), 4, /There is no repo nope here/);
  refused(away.root3(['issue', 'new', 'nope', 'x']), 4, /There is no repo nope here/);
  refused(away.root3(['repo', 'new', '.bad']), 2, /is not a repo name/);
  ok(away.root3(['repo', 'new', 'mine', '-t', 'empty']));
  refused(away.root3(['repo', 'new', 'mine']), 1, /There is a repo mine already/);
  refused(away.root3(['file', 'write', 'mine/.git/config'], 'x'), 1, /is in the repo's \.git/);
  refused(away.root3(['file', 'write', 'mine/../x'], 'x'), 1, /leaves the repo/);
  // With --json a refusal is data on standard output: its kind and its words.
  const j = away.root3(['file', 'nope/x', '--json']);
  assert.deepEqual([j.code, j.json], [4, {error: {kind: 'notFound', message: 'There is no repo nope here (root3 repo lists them)'}}]);
});

test('root3 help --json is the table an agent writes every command from: each form\'s words, flags and what it needs', async () => {
  const away = r.device();
  const all = ok(away.root3(['help', 'all', '--json'])).json as {name: string; forms: {usage: string; verb: string | null; words: {kind: string; choices?: string[]; optional?: boolean}[]; flags: {flag: string}[]; needs: string; sync: string}[]}[];
  const forms = all.flatMap((c) => c.forms.map((f) => ({c: c.name, ...f})));
  assert.ok(forms.length > 50);
  for (const f of forms) {
    assert.ok(['remote', 'device', 'anywhere'].includes(f.needs) && ['none', 'take-in', 'send'].includes(f.sync), f.usage);
    assert.ok(f.words.every((w) => typeof w.kind === 'string'), f.usage);
  }
  const set = forms.find((f) => f.c === 'address' && f.verb === 'ssh' && f.words.length === 2)!;
  assert.deepEqual(set.words, [{kind: 'choice', choices: ['on']}, {kind: 'choice', choices: ['device', 'network']}]);
  const take = forms.find((f) => f.c === 'dotfile' && f.verb === 'take' && f.words.length === 1)!;
  assert.deepEqual([take.words[0].kind, take.needs], ['dotfile', 'device']);
  // Lists are ls, whatever they list.
  assert.ok(!forms.some((f) => f.verb === 'list'), JSON.stringify(forms.filter((f) => f.verb === 'list').map((f) => f.usage)));
});
