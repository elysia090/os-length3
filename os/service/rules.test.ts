import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isDeepStrictEqual} from 'node:util';
import cases from '../shared/cases.json' with {type: 'json'};
import {applyDiff, cutId, issueOf, LIMIT, merge3, roomFor, validLine, validName, validPath} from './app.ts';
import {parseAddress, readRecord} from './inbox.ts';
import {term} from './names.ts';
import {postId} from './servers.ts';

// The Remote's rules that need no database: which paths a repo may hold,
// how a diff and a merge lay trees down, how large a body each route reads.

/** Every case whose answer is not the one wanted: [] when all agree. */
const wrong = <C>(list: readonly C[], want: (c: C) => unknown, got: (c: C) => unknown) =>
  list.map((c) => ({c, want: want(c), got: got(c)})).filter((x) => !isDeepStrictEqual(x.want, x.got));

test('a path is refused when it leaves the repo, has an empty part, or names .git however it is spelt', () => {
  const paths: [string, boolean][] = [
    ['README.md', true], ['a/b/c.txt', true], ['ノート/メモ 1.md', true], ['a b/c d', true], ['.github/workflows/x.yml', true], ['.gitignore', true],
    ['x'.repeat(1024), true], ['x'.repeat(1025), false],
    ['', false], ['/etc/passwd', false], ['a//b', false], ['a/', false], ['./a', false], ['a/./b', false], ['..', false], ['a/../../b', false],
  ];
  assert.deepEqual(wrong(paths, ([, ok]) => ok, ([p]) => validPath(p)), []);
  // Every spelling of .git the core and the app refuse (shared/cases.json), as a whole path and as a folder on the way.
  const git = cases.gitName as [string, boolean][];
  assert.deepEqual(wrong(git, ([, isGit]) => !isGit, ([n]) => validPath(n)), []);
  assert.deepEqual(wrong(git, ([, isGit]) => !isGit, ([n]) => validPath(`src/${n}/config`)), []);
});

test('names: a repo\'s and a line\'s are short words; main\'s line is the work of no issue', () => {
  const names: [string, boolean, boolean][] = [
    // name, as a repo, as a line
    ['notes', true, true], ['my-repo_1.0', true, true], ['001', true, true], ['_x', true, false], ['-x', true, false],
    ['.hidden', false, false], ['', false, false], ['a/b', false, false], ['a b', false, false], ['x'.repeat(64), true, true], ['x'.repeat(65), false, false], ['日本', false, false],
  ];
  assert.deepEqual(wrong(names, ([, repo, line]) => [repo, line], ([n]) => [validName(n), validLine(n)]), []);
  assert.deepEqual([issueOf('main'), issueOf('001'), issueOf('notes')], ['', 'issue/001.md', 'issue/notes.md']);
});

test('a diff removes a path with everything under it, then sets what it sets', () => {
  const draft = {'a.txt': '1', 'docs/x.md': '2', 'docs/y/z.md': '3', 'docsy.md': '4', 'e': null};
  assert.deepEqual(applyDiff(draft, {}, ['docs']), {'a.txt': '1', 'docsy.md': '4', 'e': null});
  // A folder removed and a file set under its name in one diff: the file is there after.
  assert.deepEqual(applyDiff(draft, {'docs': '9'}, ['docs']), {'a.txt': '1', 'docsy.md': '4', 'e': null, 'docs': '9'});
  // A file replaced by an empty folder; one removed that was never there changes nothing.
  assert.deepEqual(applyDiff({'a': '1'}, {'a': null}, ['nowhere']), {'a': null});
  assert.deepEqual(applyDiff({}, {}, []), {});
  // The draft it was laid on is left as it was.
  assert.deepEqual(draft, {'a.txt': '1', 'docs/x.md': '2', 'docs/y/z.md': '3', 'docsy.md': '4', 'e': null});
});

test('a merge takes what changed on one side, the same change once, and calls a path both changed differently a conflict', () => {
  const merges: {why: string; base: Record<string, string | null>; ours: Record<string, string | null>; theirs: Record<string, string | null>; tree: Record<string, string | null>; conflicts: string[]}[] = [
    {why: 'theirs changed', base: {a: '1'}, ours: {a: '1'}, theirs: {a: '2'}, tree: {a: '2'}, conflicts: []},
    {why: 'ours changed', base: {a: '1'}, ours: {a: '2'}, theirs: {a: '1'}, tree: {a: '2'}, conflicts: []},
    {why: 'the same change on both', base: {a: '1'}, ours: {a: '2'}, theirs: {a: '2'}, tree: {a: '2'}, conflicts: []},
    {why: 'removed on one side, untouched on the other', base: {a: '1', b: '1'}, ours: {b: '1'}, theirs: {a: '1', b: '1'}, tree: {b: '1'}, conflicts: []},
    {why: 'removed on one side, changed on the other: a conflict, ours stands', base: {a: '1'}, ours: {}, theirs: {a: '2'}, tree: {}, conflicts: ['a']},
    {why: 'changed differently: a conflict, ours stands', base: {a: '1'}, ours: {a: '2'}, theirs: {a: '3'}, tree: {a: '2'}, conflicts: ['a']},
    {why: 'added on both differently', base: {}, ours: {a: '1'}, theirs: {a: '2'}, tree: {a: '1'}, conflicts: ['a']},
    {why: 'conflicts are said in path order', base: {z: '1', a: '1'}, ours: {z: '2', a: '2'}, theirs: {z: '3', a: '3'}, tree: {z: '2', a: '2'}, conflicts: ['a', 'z']},
  ];
  assert.deepEqual(wrong(merges, (m) => ({tree: m.tree, conflicts: m.conflicts}), (m) => merge3(m.base, m.ours, m.theirs)).map((x) => x.c.why), []);
});

test('a body is read as far as its route takes: a file and a draft\'s diff are large, anything else a little', () => {
  const routes: [string, string, number][] = [
    ['PUT', '/v1/blobs/abc', LIMIT.blob], ['PATCH', '/v1/repos/notes/draft', LIMIT.body], ['PUT', '/v1/home/todo', LIMIT.body],
    ['POST', '/v1/blobs/abc', LIMIT.request], ['PATCH', '/v1/repos/notes/x/draft', LIMIT.request], ['PUT', '/v1/home/todo/x', LIMIT.request],
    ['POST', '/api/auth/sign-in/social', LIMIT.request], ['POST', '/v1/inbox/messages', LIMIT.request],
  ];
  assert.deepEqual(wrong(routes, ([, , n]) => n, ([m, p]) => roomFor(m, p)), []);
});

test('a commit\'s id is the digest of what it records, whatever order its tree was written in', async () => {
  const c = {repo: 'notes', parent: null, kind: 'Fix', title: 't', issue: '', note: '', time: 1};
  const one = await cutId({...c, tree: {a: '1', b: '2'}}), two = await cutId({...c, tree: {b: '2', a: '1'}});
  assert.match(one, /^[0-9a-f]{64}$/);
  assert.equal(one, two);
  assert.notEqual(one, await cutId({...c, tree: {a: '1', b: '2'}, time: 2}));
  assert.notEqual(one, await cutId({...c, tree: {a: '1', b: '2'}, repo: 'notes@001'}));
});

test('an address is a name and a domain, in lower case; anything else is no address', () => {
  const addresses: [string, {name: string; domain: string} | null][] = [
    ['ren@length3.com', {name: 'ren', domain: 'length3.com'}], [' Ren@Example.ORG ', {name: 'ren', domain: 'example.org'}],
    ['a.b-c_d@sub.example.co.jp', {name: 'a.b-c_d', domain: 'sub.example.co.jp'}],
    ['r@length3.com', null], ['ren', null], ['ren@', null], ['@x.com', null], ['ren@localhost', null], ['ren@x.c', null],
    ['ren@@x.com', null], ['re n@x.com', null], ['.ren@x.com', null], ['ren@-x.com', null], ['れん@x.com', null], [`${'a'.repeat(32)}@x.com`, null],
  ];
  assert.deepEqual(wrong(addresses, ([, want]) => want, ([a]) => parseAddress(a)), []);
});

test('a domain\'s record is read for its remote and proof; another record is none', () => {
  const records: [string, {remote: string; proof: string} | null][] = [
    ['v=length3; remote=remote.length3.com; proof=abc', {remote: 'remote.length3.com', proof: 'abc'}],
    ['v=length3;remote=Remote.Example;proof=x', {remote: 'remote.example', proof: 'x'}],
    ['v=length3; remote=r.example', {remote: 'r.example', proof: ''}],
    ['v=spf1 include:_spf.example ~all', null], ['v=length3; proof=x', null], ['remote=r.example; proof=x', null], ['', null],
  ];
  assert.deepEqual(wrong(records, ([, want]) => want, ([r]) => readRecord(r)), []);
});

test('a name is held for five years from the moment it is taken; a leap day rolls on to March', () => {
  assert.equal(term(Date.UTC(2026, 9, 17, 12)).toISOString(), '2031-10-17T12:00:00.000Z');
  assert.equal(term(Date.UTC(2028, 1, 29)).toISOString(), '2033-03-01T00:00:00.000Z');
});

test('a post\'s id sorts as its time, and two at one moment differ', () => {
  const a = postId(1000), b = postId(1000), later = postId(1001);
  assert.match(a, /^[0-9a-z]{17}$/);
  assert.notEqual(a, b);
  assert.ok(a.slice(0, 9) < later.slice(0, 9));
  assert.ok(postId(36 ** 9 - 1).startsWith('zzzzzzzzz'));
});
