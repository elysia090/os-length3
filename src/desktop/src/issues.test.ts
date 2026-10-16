import assert from 'node:assert/strict';
import {test} from 'node:test';
import {issueText, nextIssueName, parseIssue} from './issues.ts';

test('an issue file is read like a TODO item: first line, then detail', () => {
  assert.deepEqual(parseIssue('a', '001.md', 'Fix：再起動すると保存内容が消える\n\n再現手順\n1. 保存\n'),
    {repo: 'a', file: '001.md', kind: 'Fix', title: '再起動すると保存内容が消える', detail: '再現手順\n1. 保存'});
  assert.deepEqual(parseIssue('a', 'x.md', '# RFC: Remoteの保持期間'),
    {repo: 'a', file: 'x.md', kind: 'RFC', title: 'Remoteの保持期間', detail: ''});
  assert.equal(parseIssue('a', 'empty.md', '').title, 'empty.md');
});

test('new issues are written the same way and numbered in order', () => {
  assert.equal(issueText('Patch', ' 起動を速く ', '\n詳細\n'), 'Patch：起動を速く\n\n詳細\n');
  assert.equal(issueText(null, 'メモ', ''), 'メモ\n');
  assert.equal(nextIssueName([]), '001.md');
  assert.equal(nextIssueName(['001.md', '007.md', 'notes.md']), '008.md');
});
