import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isDeepStrictEqual} from 'node:util';
import cases from '../shared/cases.json' with {type: 'json'};
import {validName as validDotfile} from './dotfiles.ts';
import {beside, plan, type Tree} from './draft.ts';
import {closeText, issueText, nextIssueName, numberOf, parseIssue, reopenText} from './issues.ts';
import {counts, lineOps} from './linediff.ts';
import {isGitName, validName} from './repos.ts';
import {kindOf} from './text.ts';

// The same cases the core crate's tests read: the app and l3 must agree.

/** Every case whose answer is not the one wanted, each with what came instead: [] when all agree. */
function disagreeing<C>(list: readonly C[], want: (c: C) => unknown, got: (c: C) => unknown) {
  return list.map((c) => ({c, want: want(c), got: got(c)})).filter((x) => !isDeepStrictEqual(x.want, x.got));
}

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

test('an issue file is numbered by its name the same way here and in l3', () => {
  assert.deepEqual(disagreeing(cases.issueNumber as [string, number | null][], ([, n]) => n, ([file]) => numberOf(file)), []);
});

type PlanCase = {why: string; base: Tree; here: Tree; there: Tree; take: ([string] | [string, string | null])[]; both: [string, string][]};

test('a sync plans the same takes and conflicts here and in l3', () => {
  // [path] is a removal, which the app says as undefined.
  assert.deepEqual(disagreeing(cases.plan as unknown as PlanCase[],
    (c) => ({take: c.take.map(([path, ...v]) => [path, v.length ? v[0] : undefined]), both: c.both}),
    (c) => plan(c.base, c.here, c.there)).map((x) => x.c.why), []);
});

test('the copy kept beside a file is named the same way here and in l3', () => {
  assert.deepEqual(disagreeing(cases.beside as [string, string, number, string][], (c) => c[3], ([path, who, n]) => beside(path, who, n)), []);
});

test('lines changed are counted, and laid out, the same way here and in l3', () => {
  const mark = {same: '=', add: '+', del: '-'} as const;
  type Case = [string, string, number, number, string[] | null];
  const list = cases.lineDiff as Case[];
  assert.deepEqual(disagreeing(list, ([, , added, removed]) => ({added, removed}), ([a, b]) => counts(lineOps(a, b))), []);
  assert.deepEqual(disagreeing(list.filter((c) => c[4]), (c) => c[4], ([a, b]) => lineOps(a, b).map((o) => mark[o.kind] + o.text)), []);
});

test('a dotfile may be written into /root under the same names here and in l3', () => {
  assert.deepEqual(disagreeing(cases.dotfileName as [string, boolean][], ([, ok]) => ok, ([name]) => validDotfile(name)), []);
});
