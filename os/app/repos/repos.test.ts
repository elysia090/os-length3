import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isIssues, plainPart, renamed, shownEntries, TEMPLATES, templateFiles, validName} from './repos.ts';

test('repo names match the native rule', () => {
  assert.ok(validName('my-repo_1.0'));
  for (const bad of ['', '.git', 'a/b', 'a b', 'x'.repeat(65)]) assert.ok(!validName(bad), bad);
});

test('a new or renamed file or folder is one plain part, as core\'s add takes it', () => {
  for (const ok of ['a.md', 'Makefile', 'my notes.txt', 'ノート.md']) assert.ok(plainPart(ok), ok);
  for (const bad of ['', '.env', '..', 'a/b', 'a\\b', '.git', 'GIT~1', '.git. ']) assert.ok(!plainPart(bad), bad);
  assert.equal(renamed('src/main.c', 'hello.c'), 'src/hello.c');
  assert.equal(renamed('README.md', 'READ.md'), 'READ.md');
});

test('templates hold the repo\'s own files, never inbox or TODO', () => {
  for (const t of TEMPLATES) {
    const files = templateFiles('r', t.id);
    assert.ok(files.has('README.md') && !files.has('inbox.md') && !files.has('TODO.md'), t.id);
    // The list shown to the user names exactly what is created.
    const shown = t.files.map((f) => f.replace(/\/$/, '')).sort();
    assert.deepEqual([...files.keys()].sort(), shown, t.id);
  }
});

test('a repo\'s issues are not among its files where files are shown: its issue/ at the top, never one deeper', () => {
  const e = (name: string, kind: 'dir' | 'file' = 'dir') => ({name, kind, size: 0});
  assert.deepEqual(shownEntries('', [e('docs'), e('issue'), e('issues'), e('README.md', 'file')]).map((x) => x.name), ['docs', 'issues', 'README.md']);
  assert.deepEqual(shownEntries('issue', [e('001.md', 'file')]), []);
  assert.deepEqual(shownEntries('docs', [e('issue')]).map((x) => x.name), ['issue']);
  for (const [path, is] of [['issue', true], ['issue/001.md', true], ['issues', false], ['docs/issue', false], ['', false]] as const) assert.equal(isIssues(path), is, path);
});
