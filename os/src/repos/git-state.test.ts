import assert from 'node:assert/strict';
import {test} from 'node:test';
import {laidOut, stageOf, type Standing} from './git-state.ts';
import type {Change, Work} from './history.ts';
import {parseIssue} from './issues.ts';

// How Git lays issues out: open ones in the row, main's uncommitted, then merged and closed.

const work = (line: string): Work => ({line, issue: line === 'main' ? null : `issue/${line}.md`, started_by: '', started_at: 0, commits: 0, unpushed: 0, change: null});
const change = (issue: string, state: Change['state'], updatedAt: number): Change => ({id: issue, repo: 'r', line: issue.slice(6, 9), issue, kind: 'Fix', title: issue,
  version: 1, base: null, head: 'h', state, note: '', submittedBy: 'sora', updatedAt, reviews: [], folders: [], files: 1});
const standing = (s: Partial<Standing>): Standing => ({work: work('main'), changes: [], uncommitted: 0, ...s});

const r1 = parseIssue('r', '001.md', 'Fix：merged one\n');
const r2 = parseIssue('r', '002.md', 'Fix：open one\n');
const r3 = parseIssue('r', '003.md', 'Fix：closed one\n\nClosed：2031-10-07 sora\n');
const r4 = parseIssue('r', '004.md', 'Fix：merged later\n');
const q1 = parseIssue('q', '001.md', 'Feat：in another repo\n');

test('the row holds only open issues, oldest first, repo by repo', () => {
  const states = new Map([['r', standing({changes: [change('issue/001.md', 'merged', 1), change('issue/004.md', 'merged', 5)]})]]);
  const laid = laidOut(['q', 'r'], [r4, r3, r2, r1, q1], states);
  assert.deepEqual(laid.open.map((i) => `${i.repo}#${i.n}`), ['q#1', 'r#2']);
});

test('merged is newest first across repos; a rejected or open change is not merged', () => {
  const states = new Map([
    ['r', standing({changes: [change('issue/001.md', 'merged', 1), change('issue/004.md', 'merged', 5), change('issue/002.md', 'rejected', 9)]})],
    ['q', standing({changes: [change('issue/001.md', 'merged', 3)]})],
  ]);
  const laid = laidOut(['q', 'r'], [r1, r2, r4, q1], states);
  assert.deepEqual(laid.merged.map((m) => `${m.repo} ${m.change.issue}`), ['r issue/004.md', 'q issue/001.md', 'r issue/001.md']);
  assert.deepEqual(laid.open.map((i) => `${i.repo}#${i.n}`), ['r#2']);
});

test('closed ones are listed apart, reopened whatever work their repo shows (an issue is main\'s); one merged is merged, not closed', () => {
  const merged3 = new Map([['r', standing({changes: [change('issue/003.md', 'merged', 1)]})]]);
  assert.deepEqual(laidOut(['r'], [r3], merged3).closed, []);
  const onMain = laidOut(['r'], [r2, r3], new Map([['r', standing({})]]));
  assert.deepEqual(onMain.closed.map((c) => [c.issue.n, c.reopen]), [[3, true]]);
  const inWork = laidOut(['r'], [r2, r3], new Map([['r', standing({work: work('002')})]]));
  assert.deepEqual(inWork.closed.map((c) => [c.issue.n, c.reopen]), [[3, true]]);
  // Without the Remote nothing is known of where it stands: listed, but not reopened from here.
  assert.deepEqual(laidOut(['r'], [r3], new Map()).closed.map((c) => c.reopen), [false]);
});

test('main is offered a commit only while the repo shows it, has something uncommitted, and is known', () => {
  const states = new Map<string, Standing>([
    ['a', standing({uncommitted: 2})],
    ['b', standing({uncommitted: 0})],
    ['c', standing({work: work('001'), uncommitted: 3})],
    ['d', standing({uncommitted: 1, error: 'away'})],
  ]);
  assert.deepEqual(laidOut(['a', 'b', 'c', 'd', 'e'], [], states).dirty, ['a']);
});

test('an issue is open until work on it begins (here, elsewhere, or by an agent), pending until merged, then solved', () => {
  const s = standing({changes: [change('issue/001.md', 'merged', 1), change('issue/004.md', 'open', 2)]});
  assert.equal(stageOf(s, [], r2, false), 'open');
  assert.equal(stageOf(s, [{issue: 'issue/002.md'}], r2, false), 'pending');
  assert.equal(stageOf(s, [], r2, true), 'pending');
  assert.equal(stageOf(s, [], r4, false), 'pending');
  assert.equal(stageOf(s, [], r1, true), 'solved');
  assert.equal(stageOf(s, [], r3, false), 'closed');
  // Not known (no Remote): what this device knows of it.
  assert.equal(stageOf(undefined, [], r2, true), 'pending');
});
