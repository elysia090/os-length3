import assert from 'node:assert/strict';
import {test} from 'node:test';
import {closeMark, closedBy, issueName, issueText, nextIssueName, number, parseIssue, readIssues, saveIssue, setClosed, writeIssue} from './issues.ts';
import {memoryRepo} from '../testing/store.ts';

test('an issue is read like a TODO item: first line, then detail; its number is its file\'s', () => {
  assert.deepEqual(parseIssue('a', '001.md', 'Fix：再起動すると保存内容が消える\n\n再現手順\n1. 保存\n'),
    {repo: 'a', n: 1, file: '001.md', kind: 'Fix', title: '再起動すると保存内容が消える', detail: '再現手順\n1. 保存', closed: null});
  assert.deepEqual(parseIssue('a', 'x.md', '# RFC: Remoteの保持期間'),
    {repo: 'a', n: null, file: 'x.md', kind: 'RFC', title: 'Remoteの保持期間', detail: '', closed: null});
  assert.equal(parseIssue('a', 'empty.md', '').title, 'empty');
  assert.equal(issueName(parseIssue('a', '012.md', 'x')), '#12');
  assert.equal(issueName(parseIssue('a', 'notes.md', 'x')), '');
});

test('new issues are written the same way and take the next number', () => {
  assert.equal(issueText('Patch', ' 起動を速く ', '\n詳細\n'), 'Patch：起動を速く\n\n詳細\n');
  assert.equal(issueText(null, 'メモ', ''), 'メモ\n');
  assert.equal(nextIssueName([]), '001.md');
  assert.equal(nextIssueName(['001.md', '007.md', 'notes.md']), '008.md');
  assert.equal(nextIssueName(['999.md']), '1000.md');
});

const memory = memoryRepo;

test('a repo without issue/ takes an issue; issue/ is made for it', async () => {
  const s = memory({'README.md': '# a'});
  assert.equal(await writeIssue(s as never, 'a', 'Fix', 'x', ''), '001.md');
  assert.equal(s.files['issue/001.md'], 'Fix：x\n');
  assert.deepEqual((await readIssues(s as never, 'a')).map((i) => i.n), [1]);
});

test('issues without a number take the next free ones; one a work refers to keeps its name', async () => {
  const s = memory({'issue': null, 'issue/001.md': 'A', 'issue/002.md': 'B', 'issue/002 (other device).md': 'C', 'issue/notes.md': 'D', 'issue/worked.md': 'E'});
  const before = await readIssues(s as never, 'a');
  assert.deepEqual(before.map((i) => i.n), [null, null, null, 2, 1]);
  assert.equal(await number(s as never, 'a', before, new Set(['issue/worked.md'])), true);
  const after = await readIssues(s as never, 'a');
  assert.deepEqual(after.map((i) => [i.n, i.title]), [[null, 'E'], [4, 'D'], [3, 'C'], [2, 'B'], [1, 'A']]);
  // Done once, there is nothing more to do: two devices doing it agree.
  assert.equal(await number(s as never, 'a', after, new Set(['issue/worked.md'])), false);
});

test('an issue closed says so on its last line, keeps its words, and opens again as it was', async () => {
  const s = memory({'issue': null, 'issue/001.md': 'Fix：x\n\nWhy it matters.\n'});
  const [open] = await readIssues(s as never, 'a');
  await setClosed(s as never, open, closeMark('sora', new Date(2031, 9, 7)));
  assert.equal(s.files['issue/001.md'], 'Fix：x\n\nWhy it matters.\n\nClosed：2031-10-07 sora\n');
  const [closed] = await readIssues(s as never, 'a');
  assert.deepEqual([closed.title, closed.detail, closed.closed], ['x', 'Why it matters.', '2031-10-07 sora']);
  assert.deepEqual(closedBy(closed.closed!), {at: new Date(2031, 9, 7).getTime(), by: 'sora'});
  // Its words changed while closed: it stays closed.
  await saveIssue(s as never, closed, 'Fix', 'y', 'Why it matters.');
  assert.equal((await readIssues(s as never, 'a'))[0].closed, '2031-10-07 sora');
  await setClosed(s as never, (await readIssues(s as never, 'a'))[0], null);
  assert.equal(s.files['issue/001.md'], 'Fix：y\n\nWhy it matters.\n');
});

test('a close is marked with the day here, and who only when known', () => {
  assert.equal(closeMark('', new Date(2031, 0, 2)), '2031-01-02');
  assert.deepEqual(closedBy('2031-01-02'), {at: new Date(2031, 0, 2).getTime(), by: ''});
  // A line written by hand that is no day says what it says.
  assert.deepEqual(closedBy('wontfix'), {at: null, by: 'wontfix'});
});
