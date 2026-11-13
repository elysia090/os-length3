import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, existsSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {test} from 'node:test';
import {remote, type Ran} from './harness.ts';

// why end to end, against a Remote of its own (why/remote/serve/dev.ts on a free
// port, its data in a directory made for it): real commands, their words,
// their exit codes, and what the Remote holds after. Each test has repos
// and people of its own; the devices signed in here are shared, and none
// depends on another test having run. One stops the Remote and starts it
// again (same port, same data), to be a device out of its reach meanwhile.
//
//   npm run selftest:cli   (builds why; WHY=path/to/why takes that one instead)

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
/** why ran and said it was done: exit 0, nothing on standard error. */
function ok(x: Ran, says?: RegExp): Ran {
  assert.equal(x.code, 0, `${x.out}${x.err}`);
  assert.equal(x.err, '');
  if (says) assert.match(x.out, says);
  return x;
}
/** why refused, with this exit code and these words on standard error, and nothing on standard output. */
function refused(x: Ran, code: number, says: RegExp) {
  assert.equal(x.code, code, `${x.out}${x.err}`);
  assert.match(x.err, says);
  assert.equal(x.out, '');
}

test('why login connects a device through the Remote\'s approval in a browser; why remote then names the account', async () => {
  const fresh = r.device();
  const done = await fresh.login(ren);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, new RegExp(`Open this page in a browser and approve:\n {2}${r.app.replace(/[./]/g, '\\$&')}/\\?device=&user_code=\\w+\n {2}code \\w+\n`));
  assert.match(done.out, new RegExp(`Signed in · ${r.url.replace('http://', '').replace(/\./g, '\\.')}`));
  const remote = ok(fresh.why(['remote', '--json'])).json;
  assert.deepEqual([remote.url, remote.account.name], [r.url, 'Ren Selftest']);
  // Each device is a session of its own, listed with this one marked.
  const devices = ok(fresh.why(['remote', 'devices', '--json'])).json as {current: boolean}[];
  assert.ok(devices.length >= 3 && devices.filter((d) => d.current).length === 1, JSON.stringify(devices));
  ok(fresh.why(['logout']), /this device is signed out/);
  assert.equal(ok(fresh.why(['remote', '--json'])).json.url, null);
});

test('a repo made and written with why is on the Remote byte for byte, CRLF, names beyond ASCII and all', async () => {
  ok(laptop.why(['repo', 'new', 'files', '-t', 'empty']), /^Made files \(empty · 1 file\)\n$/);
  const text = '一行目\r\n二行目\r\n';
  ok(laptop.why(['file', 'write', 'files/ノート/メモ.md'], text), /^Made files\/ノート\/メモ\.md \(22 B\)\n$/);
  assert.equal(ok(laptop.why(['file', 'files/ノート/メモ.md'])).out, text);
  ok(laptop.why(['file', 'write', 'files/ノート/メモ.md'], 'changed\n'), /^Saved /);
  // Empty standard input writes nothing, unless asked.
  refused(laptop.why(['file', 'write', 'files/empty.txt'], ''), 1, /Standard input was empty, so nothing was written/);
  ok(laptop.why(['file', 'write', 'files/empty.txt', '--empty'], ''), /\(0 B\)/);
  const there = await draftOf('files');
  assert.equal(there.draft['ノート/メモ.md'], sha('changed\n'));
  assert.equal(there.draft['empty.txt'], sha(''));
  ok(laptop.why(['file', 'rm', 'files/ノート']));
  assert.equal((await draftOf('files')).draft['ノート/メモ.md'], undefined);
});

test('a file holding a key stays on this device: the Remote never has it, why remote and Commit say so, and taken out it goes', async () => {
  ok(laptop.why(['repo', 'new', 'keyed', '-t', 'empty']));
  const key = `sk-ant-api03-${'x'.repeat(91)}k9AA`;
  ok(laptop.why(['file', 'write', 'keyed/.env'], `ANTHROPIC_API_KEY=${key}\n`));
  ok(laptop.why(['file', 'write', 'keyed/notes.md'], 'plain\n'));
  // What holds none goes as ever; the key's file does not, nor is anything of it removed there.
  const there = await draftOf('keyed');
  assert.equal(there.draft['notes.md'], sha('plain\n'));
  assert.equal(there.draft['.env'], undefined);
  // In step otherwise: the key's file is not a change waiting to go, it is one that cannot.
  assert.match(ok(laptop.why(['remote'])).out, /\n {2}keyed {2,}in step · 1 cannot be sent\n/);
  const row = (ok(laptop.why(['remote', '--json'])).json.here as {name: string; unsendable: string[]}[]).find((x) => x.name === 'keyed');
  assert.deepEqual(row?.unsendable, ['.env']);
  refused(laptop.why(['commit', 'keyed', 'Patch：keys']), 1, /\(\.env: secret sk-ant-…k9AA\)/);
  // Never the key whole, in anything said.
  assert.doesNotMatch(JSON.stringify(ok(laptop.why(['remote', '--json'])).json), /x{20}/);
  ok(laptop.why(['file', 'write', 'keyed/.env'], 'ANTHROPIC_API_KEY=\n'));
  assert.equal((await draftOf('keyed')).draft['.env'], sha('ANTHROPIC_API_KEY=\n'));
});

test('why repo mv and rm do what the repo\'s gear does: one only this device has is renamed and deleted, one on the Remote is not', async () => {
  const alone = r.device();
  ok(alone.why(['repo', 'new', 'draft', '-t', 'empty']));
  ok(alone.why(['repo', 'mv', 'draft', 'notes']), /^Renamed draft to notes\n$/);
  assert.match(ok(alone.why(['repo'])).out, /^notes /m);
  ok(alone.why(['repo', 'rm', 'notes']), /^Deleted notes from this device\n$/);
  assert.doesNotMatch(ok(alone.why(['repo'])).out, /notes/);
  // On the Remote, which knows it by its name and guards it with a passkey: said where it is done, nothing done here.
  ok(laptop.why(['repo', 'new', 'kept', '-t', 'empty']));
  refused(laptop.why(['repo', 'mv', 'kept', 'other']), 1, /kept is on the Remote/);
  refused(laptop.why(['repo', 'rm', 'kept']), 1, /kept is on the Remote: turn it off there first/);
  assert.match(ok(laptop.why(['repo'])).out, /^kept /m);
});

test('another device opens the repo from the Remote, and takes in each change made on the first when it reads', async () => {
  ok(laptop.why(['repo', 'new', 'shared', '-t', 'empty']));
  ok(laptop.why(['file', 'write', 'shared/a.txt'], 'one\n'));
  assert.match(ok(desk.why(['repo'])).out, /^shared {2,}only on the Remote/m);
  ok(desk.why(['repo', 'open', 'shared']), /^shared is here now/);
  assert.equal(ok(desk.why(['file', 'shared/a.txt'])).out, 'one\n');
  ok(laptop.why(['file', 'write', 'shared/a.txt'], 'two\n'));
  assert.equal(ok(desk.why(['file', 'shared/a.txt'])).out, 'two\n');
  // And back: the desk's change reaches the laptop.
  ok(desk.why(['file', 'write', 'shared/b.txt'], 'from the desk\n'));
  assert.equal(ok(laptop.why(['file', 'shared/b.txt'])).out, 'from the desk\n');
  assert.match(ok(laptop.why(['remote'])).out, /\n {2}shared {2,}in step/);
});

test('a script\'s execute bit goes to the Remote and comes back with it: opened on another device, after a change, and after Free and opening again', async () => {
  const at = (d: {home: string}, path: string) => join(d.home, 'why', 'repos', path);
  const mode = (d: {home: string}, path: string) => statSync(at(d, path)).mode & 0o777;
  const runs = (d: {home: string}, path: string) => spawnSync(at(d, path), [], {encoding: 'utf8'});
  ok(laptop.why(['repo', 'new', 'scripts', '-t', 'empty']));
  ok(laptop.why(['file', 'write', 'scripts/run.sh'], '#!/bin/sh\necho ran one\n'));
  chmodSync(at(laptop, 'scripts/run.sh'), 0o755);
  // A mode alone is a change: it is sent (why repo sends what changed before it lists).
  ok(laptop.why(['repo']));
  assert.deepEqual((await r.api(ren, 'GET', '/v1/repos/scripts')).json.modes, {'run.sh': 0o755});
  ok(desk.why(['repo', 'open', 'scripts']));
  assert.equal(mode(desk, 'scripts/run.sh'), 0o755);
  assert.equal(runs(desk, 'scripts/run.sh').stdout, 'ran one\n');
  // Changed on the laptop: the desk takes the new bytes, and the bit stays.
  ok(laptop.why(['file', 'write', 'scripts/run.sh'], '#!/bin/sh\necho ran two\n'));
  assert.equal(mode(laptop, 'scripts/run.sh'), 0o755);
  ok(desk.why(['file', 'scripts/run.sh']));
  assert.equal(mode(desk, 'scripts/run.sh'), 0o755);
  assert.equal(runs(desk, 'scripts/run.sh').stdout, 'ran two\n');
  // Freed on the desk and opened again: as it was.
  ok(desk.why(['free', 'scripts']));
  assert.ok(!existsSync(at(desk, 'scripts')));
  ok(desk.why(['repo', 'open', 'scripts']));
  assert.equal(mode(desk, 'scripts/run.sh'), 0o755);
  assert.equal(runs(desk, 'scripts/run.sh').stdout, 'ran two\n');
  // Taken off on the laptop: a plain file on the desk too.
  chmodSync(at(laptop, 'scripts/run.sh'), 0o644);
  ok(laptop.why(['repo']));
  ok(desk.why(['file', 'scripts/run.sh']));
  assert.equal(mode(desk, 'scripts/run.sh') & 0o111, 0);
});

test('an issue goes from written to merged with why: start, commit (handed in by itself), review, merge; the Remote holds each step', async () => {
  ok(laptop.why(['repo', 'new', 'work']));
  ok(laptop.why(['issue', 'new', 'work', 'Fix：落ちる', '-m', '再現手順']), /^Wrote work#1 Fix：落ちる\n$/);
  // The issue is history on main at once, by itself, after what the repo was made with (its first commit, Start).
  const first = ((await r.api(ren, 'GET', '/v1/repos/work/log?summary=1')).json as {title: string; files: number}[]).map((c) => [c.title, c.files]);
  assert.deepEqual(first.map(([t]) => t), ['Issue #1: Fix：落ちる', 'Start']);
  assert.equal(first[0][1], 1);
  assert.match(ok(laptop.why(['git', 'work'])).out, /#1 Fix：落ちる\n {4}work · not started\n {4}next: why start work#1/);
  // What the person writes on main is theirs to commit, by itself.
  ok(laptop.why(['file', 'write', 'work/notes.txt'], 'notes\n'));
  ok(laptop.why(['commit', 'work', 'Patch：はじめ']), /^Committed [0-9a-f]{12} {2}Patch：はじめ \(1 file/);
  ok(laptop.why(['start', 'work#1']), /^Working on work#1 Fix：落ちる/);
  ok(laptop.why(['file', 'write', 'work/fix.txt'], 'fixed\n'));
  // On an issue's work a commit is handed in as it is made: there is nothing left to submit.
  ok(laptop.why(['commit', 'work']), /^Committed [0-9a-f]{12} {2}Fix：落ちる \(1 file \+1 −0\)\n {2}handed to main as version 1\n$/);
  ok(laptop.why(['submit', 'work']), /^Nothing new to submit: version 1 of Fix：落ちる is with main already\n$/);
  const change = ((await r.api(ren, 'GET', '/v1/repos/work/changes')).json as {state: string; version: number; issue: string}[])[0];
  assert.deepEqual([change.state, change.version, change.issue], ['open', 1, 'issue/001.md']);
  // main does not have the fix until it is merged.
  assert.equal((await draftOf('work')).draft['fix.txt'], undefined);
  ok(laptop.why(['review', 'work#1', 'approve', '-m', 'good']), /^Approved version 1 of Fix：落ちる/);
  ok(laptop.why(['merge', 'work#1']), /^Merged Fix：落ちる into main \(version 1\)/);
  assert.equal(((await r.api(ren, 'GET', '/v1/repos/work/changes')).json as {state: string}[])[0].state, 'merged');
  assert.equal((await draftOf('work')).draft['fix.txt'], sha('fixed\n'));
  const log = ok(laptop.why(['log', 'work', '--json'])).json as {title: string; kind: string}[];
  assert.deepEqual(log.map((c) => (c.kind ? `${c.kind}：${c.title}` : c.title)).slice(-3), ['Patch：はじめ', 'Issue #1: Fix：落ちる', 'Start']);
  refused(laptop.why(['issue', 'work#9']), 4, /work has no issue #9/);
});

test('TODO: add, list, done and undone, remove; a number not in the list is not found', async () => {
  const home = r.device();
  ok(home.why(['todo']), /No TODO yet/);
  ok(home.why(['todo', 'add', 'Fix：牛乳', '-m', '二本']), /^Added to TODO: Fix：牛乳 \(1 open\)\n$/);
  ok(home.why(['todo', 'add', '電話する']), /\(2 open\)/);
  const list = ok(home.why(['todo', '--json'])).json as {id: string; kind: string | null; title: string; detail: string; done: boolean}[];
  assert.deepEqual(list.map((t) => [t.kind, t.title, t.detail, t.done]), [['Fix', '牛乳', '二本', false], [null, '電話する', '', false]]);
  assert.notEqual(list[0].id, list[1].id);
  assert.equal(ok(home.why(['todo'])).out, '  1 ○ Fix：牛乳\n        二本\n  2 ○ 電話する\n');
  ok(home.why(['todo', 'done', '1']), /^Done: Fix：牛乳/);
  ok(home.why(['todo', 'done', '1']), /^Not done again: Fix：牛乳/);
  ok(home.why(['todo', 'rm', '2']));
  refused(home.why(['todo', 'rm', '2']), 4, /There is no TODO number 2 \(1 to 1\)/);
  refused(home.why(['todo', 'done', 'x']), 2, /Not how why todo done x is written/);
  refused(home.why(['todo', 'add', '']), 2, /The TODO's first line is empty/);
  assert.equal((ok(home.why(['todo', '--json'])).json as unknown[]).length, 1);
});

test('TODO changed on two devices, one away from the Remote meanwhile: what each changed is kept, as the app joins them', async () => {
  const kai = await r.browser('Kai Selftest');
  const one = r.device(), two = r.device();
  for (const d of [one, two]) assert.equal((await d.login(kai)).code, 0);
  const list = (d: typeof one) => (ok(d.why(['todo', '--json'])).json as {title: string; done: boolean}[]).map((t) => [t.title, t.done]);
  ok(one.why(['todo', 'add', '牛乳']));
  ok(one.why(['todo', 'add', '電話する']));
  assert.deepEqual(list(two), [['牛乳', false], ['電話する', false]]);
  // The second device writes one while the Remote is out of reach: it is kept there, and why says so once.
  await r.stop();
  const away = two.why(['todo', 'add', '手紙']);
  assert.equal(away.code, 0, away.err);
  assert.match(away.out, /^Added to TODO: 手紙 \(3 open\)\n$/);
  assert.equal(away.err.match(/Home's TODO is not in step with the Remote yet/g)?.length, 1, away.err);
  await r.start();
  // Meanwhile the first marks one done and removes the other.
  ok(one.why(['todo', 'done', '1']));
  ok(one.why(['todo', 'rm', '2']));
  // Back in reach, the second takes in both and sends its own; the first then has the same.
  const want = [['牛乳', true], ['手紙', false]];
  assert.deepEqual(list(two), want);
  assert.deepEqual(list(one), want);
  const there = (await r.api(kai, 'GET', '/v1/home/todo')).json as {value: string};
  assert.deepEqual((JSON.parse(there.value) as {title: string; done: boolean}[]).map((t) => [t.title, t.done]), want);
});

test('an issue that will not be done is closed in its own file, on the Remote too; another device reopens it', async () => {
  ok(laptop.why(['repo', 'new', 'tasks', '-t', 'empty']));
  ok(laptop.why(['issue', 'new', 'tasks', 'Fix：やらない', '-m', '理由']), /^Wrote tasks#1 Fix：やらない\n$/);
  ok(laptop.why(['issue', 'close', 'tasks#1']), /^Closed tasks#1; it will not be done \(back with: why issue reopen tasks#1\)\n$/);
  ok(laptop.why(['issue', 'close', 'tasks#1']), /^tasks#1 is closed already\n$/);
  assert.match(await textOf('tasks', 'issue/001.md'), /^Fix：やらない\n\n理由\n\nClosed：\d{4}-\d{2}-\d{2}( .+)?\n$/);
  const git = ok(laptop.why(['git', 'tasks', '--json'])).json as {closed: {repo: string; issues: string[]}[]};
  assert.deepEqual(git.closed.map((c) => [c.repo, c.issues.length]), [['tasks', 1]]);
  assert.match(ok(laptop.why(['issue', 'tasks#1'])).out, /closed \d{4}-\d{2}-\d{2}/);
  ok(desk.why(['repo', 'open', 'tasks']));
  ok(desk.why(['issue', 'reopen', 'tasks#1']), /^Reopened tasks#1\n$/);
  assert.equal(await textOf('tasks', 'issue/001.md'), 'Fix：やらない\n\n理由\n');
  assert.deepEqual((ok(laptop.why(['git', 'tasks', '--json'])).json as {closed: unknown[]}).closed, []);
  // Each was history on main by itself as it happened: written, closed, reopened (from either device), after what
  // the repo was made with.
  const log = ((await r.api(ren, 'GET', '/v1/repos/tasks/log?summary=1')).json as {title: string; files: number}[]).map((c) => [c.title, c.files]);
  assert.deepEqual(log.map(([t]) => t), ['Reopen #1: Fix：やらない', 'Close #1: Fix：やらない', 'Issue #1: Fix：やらない', 'Start']);
  assert.deepEqual(log.slice(0, 3).map(([, n]) => n), [1, 1, 1]);
});

test('why name answers with the username alone, given at sign-in; why name set changes it; why name ls with the code; why address, off a terminal with SSH off, says so with 5', async () => {
  const sora = await r.browser('Sora Selftest');
  const d = r.device();
  assert.equal((await d.login(sora)).code, 0);
  assert.equal(ok(d.why(['name'])).out, 'sora-selftest@length3.test\n');
  ok(d.why(['name', 'set', '@soraself']), /^Your username: soraself \(the one before is held for you 30 days\)\n$/);
  assert.equal(ok(d.why(['name'])).out, 'soraself@length3.test\n');
  // In the list a name on the Remote's own domain is said without it.
  assert.match(ok(d.why(['name', 'ls'])).out, /^soraself\nYour code: \d{6} /);
  // As every list is asked for (ls); list, as it was, still answers.
  assert.match(ok(d.why(['name', 'list'])).out, /^soraself\n/);
  // SSH is this device's (why/remote/repos/ssh.ts): off at first, and a script is told, never asked.
  refused(d.why(['address']), 5, /SSH is off on this device/);
});

test('Inbox: a request to someone who has not accepted, their answer, and a block that stops them', async () => {
  const mio = await r.browser('Mio Selftest');
  ok(laptop.why(['name', 'set', 'renself']), /^Your username: renself /);
  assert.equal((await r.api(mio, 'PUT', '/v1/inbox/username', {name: 'mioself'})).status, 200);
  ok(laptop.why(['inbox', 'send', 'mioself', 'Review：見てください /root/shared/a.txt']), /^Sent to mioself@length3\.test as a request/);
  const threads = (await r.api(mio, 'GET', '/v1/inbox/threads')).json as {address: string; state: string; last: {type: string; body: string}}[];
  assert.deepEqual(threads.map((t) => [t.address, t.state, t.last.type]), [['renself@length3.test', 'request', 'review']]);
  // Ren wrote first, so Mio's answer is no request.
  assert.equal((await r.api(mio, 'POST', '/v1/inbox/messages', {to: 'renself', body: 'はい\u001b[2J'})).json.request, false);
  const said = ok(laptop.why(['inbox', 'mioself'])).out;
  assert.match(said, /you · Review request · 見てください \/root\/shared\/a\.txt/);
  // What another wrote is shown without its control characters.
  assert.match(said, /mioself · はい�\[2J/);
  ok(laptop.why(['inbox', 'block', 'mioself']), /^Blocked mioself@length3\.test/);
  assert.equal((await r.api(mio, 'POST', '/v1/inbox/messages', {to: 'renself', body: 'again'})).status, 403);
  refused(laptop.why(['inbox', 'send', 'nobody-here', 'hi']), 1, /No user found with that (address|name)/);
});

test('what why cannot do has its exit code: how it is written (2), no Remote (3), not there (4), refused (1)', async () => {
  const away = r.device();
  refused(away.why(['frobnicate']), 2, /Not a command: why frobnicate/);
  refused(away.why(['log', 'files']), 3, /why log needs the Remote, and this device is not signed in to one \(why login\)/);
  refused(away.why(['repo', 'open', 'files']), 3, /needs the Remote/);
  refused(away.why(['file', 'nope/x']), 4, /There is no repo nope here/);
  refused(away.why(['issue', 'new', 'nope', 'x']), 4, /There is no repo nope here/);
  refused(away.why(['repo', 'new', '.bad']), 2, /is not a repo name/);
  ok(away.why(['repo', 'new', 'mine', '-t', 'empty']));
  refused(away.why(['repo', 'new', 'mine']), 1, /There is a repo mine already/);
  refused(away.why(['file', 'write', 'mine/.git/config'], 'x'), 1, /is in the repo's \.git/);
  refused(away.why(['file', 'write', 'mine/../x'], 'x'), 1, /leaves the repo/);
  // With --json a refusal is data on standard output: its kind and its words.
  const j = away.why(['file', 'nope/x', '--json']);
  assert.deepEqual([j.code, j.json], [4, {error: {kind: 'notFound', message: 'There is no repo nope here (why repo lists them)'}}]);
});

test('why help --json is the table an agent writes every command from: each form\'s words, flags and what it needs', async () => {
  const away = r.device();
  const all = ok(away.why(['help', 'all', '--json'])).json as {name: string; forms: {usage: string; verb: string | null; words: {kind: string; choices?: string[]; optional?: boolean}[]; flags: {flag: string}[]; needs: string; sync: string}[]}[];
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
