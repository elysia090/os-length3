import '../../../app/styles/tokens.css';
import {diffPaper} from '../../../app/pages/git/diff-paper.ts';
import type {FileDiff, ReviewLine} from '../../../repo/history.ts';

const path = 'src/main.c';
const files: FileDiff[] = [{
  path, status: 'modified', binary: false, more: 0,
  lines: [
    {kind: 'hunk', text: '@@ -1,135 +1,134 @@'},
    {kind: 'same', text: '#include <stdio.h>', old: 1, new: 1},
    {kind: 'del', text: '    puts("hello");', at: 2},
    {kind: 'add', text: '    if (puts("hello") == EOF || fflush(stdout) == EOF)', at: 2},
    {kind: 'add', text: '        return 1;', at: 3},
    {kind: 'same', text: '    return 0;', old: 3, new: 4},
    // A legacy line for which only the new number is known.
    {kind: 'same', text: '}', at: 5},
    {kind: 'hunk', text: '…'},
    ...Array.from({length: 128}, (_, index) => ({
      kind: 'same' as const, old: 8 + index, new: 9 + index, text: `    puts("long fixture ${index}${' '.repeat(165)}end");`,
    })),
  ],
}, {
  path: 'docs/usage:notes.md', status: 'added', binary: false, more: 4,
  lines: [{kind: 'add', text: 'Usage', at: 1}],
}];
const host = document.querySelector<HTMLElement>('#diff-fixture')!;
let current: ReturnType<typeof diffPaper>;
const events: ReviewLine[][] = [];

function mount(key: string, linked: readonly ReviewLine[] = [], writable = true) {
  current = diffPaper(files, {key, linked, onMarks: writable ? (marks) => events.push(marks) : undefined});
  host.replaceChildren(current.element);
}

export interface DiffFixture {
  mount: typeof mount;
  reveal(line: ReviewLine): boolean;
  events: typeof events;
}

const fixture: DiffFixture = {mount, reveal: (line) => current.reveal(line), events};
Object.assign(window, {diffFixture: fixture});
mount('demo/1/base/head');
