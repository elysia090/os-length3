import {h} from '../../ui/dom.ts';
import * as gitops from '../../repos/history.ts';
import {issueName, issuePath, readIssues, type Issue} from '../../repos/issues.ts';
import {t, tn} from '../../i18n/i18n.ts';
import {onRenamed, rekey} from '../../repos/repos.ts';
import type {Run} from './terminal.ts';
import {answers} from '../kit/common.ts';
import {connection} from '../../remote/connection.ts';
import {kindWords} from '../kit/todo-list.ts';
import {diffFiles, fileName} from '../kit/diff-view.ts';
import {issueStore} from '../../repos/issue-store.ts';
import type {Ask} from './asks.ts';
import {answerNodes} from './agent.ts';

// The kinds under the search box, side by side to switch between: the repo's issues, its diff, what was run in its
// Prompt (Output), and what was asked of its Agent. Each as a row, in a pill's list and in what a search finds, and
// one of each read whole.

export type Kind = 'issue' | 'diff' | 'output' | 'agent';
/** The kinds as the switch shows them, in order, each with its word. */
export const KINDS: {kind: Kind; label: () => string}[] = [
  {kind: 'issue', label: () => t('Issue')}, {kind: 'diff', label: () => t('diff')}, {kind: 'output', label: () => t('Output')},
  {kind: 'agent', label: () => t('Agent')},
];

/** Lines of a run's output shown before "n more lines". */
const RUN_LINES = 40;

/**
 * Lines of each repo's diff marked as with a highlighter, to come back to
 * while reading: kept by what the line is (its file, kind, text and which
 * time that text comes in the file), so a mark stays on its line as the diff
 * is drawn again, and goes when the line does.
 */
const marks = new Map<string, Set<string>>();
onRenamed((from, to) => rekey(marks, from, to));

/** `text` with each place `query` is in it (any case) marked, as a line found is. */
const markedIn = (text: string, query: string): Node[] => {
  if (!query) return [document.createTextNode(text)];
  const out: Node[] = [], low = text.toLowerCase(), q = query.toLowerCase();
  let at = 0;
  for (let k = low.indexOf(q); k >= 0; k = low.indexOf(q, k + q.length)) {
    if (k > at) out.push(document.createTextNode(text.slice(at, k)));
    out.push(h('mark', {}, text.slice(k, k + q.length)));
    at = k + q.length;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out;
};

/** An issue's number and kind, as they come before its title. */
const issueHead = (i: Issue) => [issueName(i) ? h('span', {class: 'issue-no'}, `${issueName(i)} `) : null,
  i.kind ? h('span', {class: 'issue-kind'}, ...kindWords(i.kind)) : null];

/** What an issue read under the box is called in the line: its number, its kind and its title. */
export const issueLabel = (issue: Issue) => `${issueName(issue) ? `${issueName(issue)} ` : ''}${issue.kind ? `${issue.kind}：` : ''}${issue.title}`;

/**
 * An issue as a row: its number, its kind and its title; found by a search (`query`), what was found in the title is
 * marked as in a line. Pressed, it is read (`read`).
 */
export function issueButton(i: Issue, query: string, read: (i: Issue) => void): HTMLElement {
  const b = h('button', {type: 'button', class: 'choice found-item'}, h('span', {class: 'found-what'}, ...issueHead(i), ...markedIn(i.title, query)));
  b.addEventListener('click', () => read(i));
  return b;
}

/** A line run as a row says it: its first line, and that more follow (lines sent at once). */
export const firstLine = (line: string) => { const nl = line.indexOf('\n'); return nl < 0 ? line : `${line.slice(0, nl)} …`; };

/** A run as a row: its line (the first of several), and how long it took (or that it is running). */
export function runButton(r: Run, read: (r: Run) => void): HTMLElement {
  const b = h('button', {type: 'button', class: 'choice found-item'}, h('span', {class: 'found-what mono'}, firstLine(r.line)),
    h('span', {class: 'row-meta'}, r.ms === null ? t('Running') : `${r.ms} ms`));
  b.addEventListener('click', () => read(r));
  return b;
}

/** A question asked of the Agent as a row: its first line, and that it is still at work. */
export function askButton(a: Ask, read: (a: Ask) => void): HTMLElement {
  const b = h('button', {type: 'button', class: 'choice found-item'}, h('span', {class: 'found-what'}, firstLine(a.question)),
    a.done ? null : h('span', {class: 'row-meta'}, t('At work')));
  b.addEventListener('click', () => read(a));
  return b;
}

/**
 * One question asked of the Agent, whole: the question, then what it did and said in the order it came (a step as
 * the pane's flow says it, its words as an answer reads), why it stopped where it was refused, and that it is at work.
 */
export function askView(a: Ask): HTMLElement {
  return h('div', {class: 'hit-group ask'}, h('p', {class: 'ask-question'}, a.question),
    ...a.parts.map((p) => (p.kind === 'step' ? h('p', {class: 'ask-step'}, p.text) : h('div', {class: 'ask-words'}, ...answerNodes(p.text)))),
    a.refused ? h('p', {class: 'answer-refused'}, a.refused) : null,
    a.done ? null : h('p', {class: 'muted small'}, t('At work')));
}

/** A changed file as a row: its name, and what its change comes to (`count`); pressed, its diff is read. */
export function diffButton(path: string, count: HTMLElement, read: (path: string) => void): HTMLElement {
  const b = h('button', {type: 'button', class: 'choice found-item'}, h('span', {class: 'found-what mono'}, fileName(path)), count);
  b.addEventListener('click', () => read(path));
  return b;
}

/** One issue in full; its words open in the center to be changed (`change`). */
export function issueOne(issue: Issue, change: () => void): HTMLElement {
  const go = h('button', {type: 'button', class: 'button small-button choice'}, t('Edit description'));
  go.addEventListener('click', change);
  return h('article', {class: 'issue-one'}, h('h3', {}, ...issueHead(issue), issue.title),
    issue.detail ? h('p', {class: 'issue-body'}, issue.detail) : null, answers(go));
}

/**
 * Files of a diff of `repo`'s copy here: a name opens the file, a line's number opens it there (`reveal`), a line
 * pressed is marked.
 */
export function markedDiff(repo: string, files: gitops.FileDiff[], reveal: (path: string, line?: number) => void): HTMLElement[] {
  const marked = marks.get(repo) ?? new Set<string>();
  marks.set(repo, marked);
  // The same text twice in a file is two lines: each is told apart by which time it comes.
  const times = new Map<string, number>();
  return diffFiles(files, {
    reveal,
    putBack: (f) => gitops.putBack(repo, f.path),
    // Pressing a line marks it, again unmarks it; its number still opens the center there.
    line: (row, key, l) => {
      const line = `${key.slice(0, key.lastIndexOf(':'))}\n${l.kind}\n${l.text}`;
      const n = (times.get(line) ?? 0) + 1;
      times.set(line, n);
      const what = `${line}\n${n}`;
      row.classList.add('markable');
      // The line's words are what is marked: heard as a toggle named by them, pressed while marked.
      const words = row.querySelector<HTMLElement>('.diff-words');
      words?.setAttribute('role', 'button');
      const paint = () => { row.classList.toggle('marked', marked.has(what)); words?.setAttribute('aria-pressed', String(marked.has(what))); };
      paint();
      row.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).closest('.diff-no')) return;
        if (marked.has(what)) marked.delete(what); else marked.add(what);
        paint();
      });
    },
  });
}

/** One run: the line (pressed, it is back in the prompt box), how long it took (or that it is running), then its output. */
export function runView(r: Run, recall?: (line: string) => void): HTMLElement {
  const lines = r.output.replace(/\n$/, '').split('\n');
  const shown = r.output ? lines.slice(0, RUN_LINES) : [];
  let line: HTMLElement = h('span', {class: 'run-line'}, r.line);
  if (recall) {
    line = h('button', {type: 'button', class: 'hit-file run-line', title: t('Send back to prompt')}, r.line);
    line.addEventListener('click', () => recall(r.line));
  }
  return h('div', {class: 'hit-group run', 'data-started': String(r.started)},
    h('div', {class: 'run-head'}, line, h('span', {class: 'row-meta'}, r.ms === null ? t('Running') : `${r.ms} ms`)),
    ...(shown.length ? [h('pre', {class: 'run-out'}, shown.join('\n'))] : []),
    ...(lines.length > RUN_LINES ? [h('p', {class: 'muted small'}, tn('{n} more line', '{n} more lines', lines.length - RUN_LINES))] : []));
}

/** The issues of `repo` whose change was merged ("issue/001.md"); none known without the Remote. */
const mergedIssues = (repo: string): Promise<Set<string>> => (connection()
  ? gitops.changesOf(repo).then((list) => new Set(list.filter((c) => c.state === 'merged').map((c) => c.issue)), () => new Set<string>())
  : Promise.resolve(new Set<string>()));

/** The repo's open issues, as Git shows them: one merged or closed is done with. */
export async function openIssues(repo: string): Promise<Issue[]> {
  const [all, merged] = await Promise.all([readIssues(issueStore, repo), mergedIssues(repo)]);
  return all.filter((i) => i.closed === null && !merged.has(issuePath(i)));
}
