import assert from 'node:assert/strict';
import {test} from 'node:test';
import {issueName, issueText, nextIssueName, number, parseIssue, readIssues, writeIssue} from './issues.ts';

test('an issue is read like a TODO item: first line, then detail; its number is its file\'s', () => {
  assert.deepEqual(parseIssue('a', '001.md', 'Fix：再起動すると保存内容が消える\n\n再現手順\n1. 保存\n'),
    {repo: 'a', n: 1, file: '001.md', kind: 'Fix', title: '再起動すると保存内容が消える', detail: '再現手順\n1. 保存'});
  assert.deepEqual(parseIssue('a', 'x.md', '# RFC: Remoteの保持期間'),
    {repo: 'a', n: null, file: 'x.md', kind: 'RFC', title: 'Remoteの保持期間', detail: ''});
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

/** A repo's files, as the store keeps them (a folder is null). */
function memory(files: Record<string, string | null>) {
  const kids = (dir: string) => [...new Set(Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1).split('/')[0]))];
  return {
    files,
    async tree(_: string, dir: string) {
      if (!(dir in files) && !kids(dir).length) throw new Error(`no ${dir}`);
      return kids(dir).map((name) => ({name, kind: typeof files[`${dir}/${name}`] === 'string' ? 'file' : 'dir', size: 0}));
    },
    async read(_: string, path: string) { if (typeof files[path] !== 'string') throw new Error(`no ${path}`); return {text: files[path], truncated: false}; },
    async mkdir(_: string, path: string) { files[path] = null; },
    async add(_: string, dir: string, name: string, text: string) { if (`${dir}/${name}` in files) throw new Error('exists'); files[`${dir}/${name}`] = text; return text.length; },
    async remove(_: string, path: string) { delete files[path]; },
  };
}

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
