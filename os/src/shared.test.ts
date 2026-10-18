import assert from 'node:assert/strict';
import {test} from 'node:test';
import cases from '../shared/cases.json' with {type: 'json'};
import {closeText, issueText, nextIssueName, parseIssue, reopenText} from './issues.ts';
import {isGitName, validName} from './repos.ts';
import {kindOf} from './text.ts';

// The same cases the core crate's tests read: the app and l3 must agree.

test('a first line is named the same way here and in l3', () => {
  for (const [line, kind, title] of cases.kind as [string, string | null, string][]) {
    assert.deepEqual(kindOf(line), {kind, title}, line);
  }
});

test('issues are read, written and numbered the same way here and in l3', () => {
  for (const [text, kind, title, detail] of cases.issue as [string, string | null, string, string][]) {
    const i = parseIssue('r', 'x.md', text);
    assert.deepEqual([i.kind, i.title, i.detail], [kind, title, detail], text);
  }
  for (const [kind, title, detail, want] of cases.issueText as [string | null, string, string, string][]) {
    assert.equal(issueText(kind, title, detail), want);
  }
  for (const [text, kind, title, detail, closed, open] of cases.closed as [string, string | null, string, string, string | null, string][]) {
    const i = parseIssue('r', 'x.md', text);
    assert.deepEqual([i.kind, i.title, i.detail, i.closed], [kind, title, detail, closed], text);
    assert.equal(reopenText(text), open, text);
  }
  for (const [text, mark, want] of cases.close as [string, string, string][]) {
    assert.equal(closeText(text, mark), want, text);
    assert.equal(parseIssue('r', 'x.md', want).closed, mark);
  }
  for (const [names, want] of cases.nextIssue as [string[], string][]) assert.equal(nextIssueName(names), want);
  for (const [name, ok] of cases.validName as [string, boolean][]) assert.equal(validName(name), ok, name);
  for (const [name, git] of cases.gitName as [string, boolean][]) assert.equal(isGitName(name), git, name);
});
