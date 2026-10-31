import {h} from '../../ui/dom.ts';
import type {FileChange} from '../../repos/history.ts';
import {issueName, issuePath, shownPath, type Issue} from '../../repos/issues.ts';
import {t, tn} from '../../i18n.ts';
import {inPieces, store, walkRepo, type Change} from '../../repos/repos.ts';
import {findInText, nameFirst, nameMatches, type Hit} from '../../repos/search.ts';
import type {Run} from '../bench/terminal.ts';
import {kindColon} from '../todo-list.ts';
import {counted, fileName} from './diff-view.ts';
import {diffButton, issueButton, runButton, type Kind} from './kinds.ts';

// What a search under the box finds in the repo: its files and the lines in them, and of the pill pressed (or of
// all three) its issues, its changes and its runs.

const FILE_LIMIT = 2000;
const HIT_LIMIT = 200;
/** Issues and runs said under the box for a search, at most. */
const OTHER_LIMIT = 20;

/** The repo's text files as read for a search: each one's path and text. */
export type Files = {path: string; text: string}[];

/**
 * The repo's text files (the first FILE_LIMIT of them in the walk's order), read once per search session: listed a
 * level at a time and read a few megabytes at once, so the first search costs a few trips to the core, not one a file.
 */
export async function readAll(repo: string): Promise<Files> {
  const files = (await walkRepo(repo)).filter((f) => f.entry.kind === 'file');
  const texts = (got: (Files[number] | null)[]) => got.filter((f) => f !== null).length >= FILE_LIMIT;
  // Gone since the listing (a Prompt, another device): nothing of it to search.
  const read = await inPieces(files, (f) => f.entry.size, (f) => store.read(repo, f.path).then((c) => (c.text != null ? {path: f.path, text: c.text} : null), () => null),
    undefined, texts);
  return read.filter((f) => f !== null).slice(0, FILE_LIMIT);
}

/** The files read for a search, as a change saved since leaves them: the file's new text, or read again. */
export function patched(files: Promise<Files>, c: Change): Promise<Files> | null {
  if (c.what !== 'file' || c.text == null) return null;
  return files.then((list) => {
    const at = list.findIndex((f) => f.path === c.path);
    if (at < 0) return [...list, {path: c.path, text: c.text!}];
    const next = list.slice();
    next[at] = {path: c.path, text: c.text!};
    return next;
  });
}

/** A line as written, a full-width colon after a Latin word ("Fix：") tucked against it as kindWords tucks it. */
const tucked = (text: string): Node[] => text.split(/(?<=[A-Za-z0-9])(：)/).filter(Boolean)
  .map((x) => x === '：' ? kindColon() : document.createTextNode(x));

type Group = {path: string; hits: Hit[]};

/** What was found: the files with the lines found in them, and the issues, changes and runs. */
interface Found { groups: Group[]; issues: Issue[]; diffs: FileChange[]; runs: Run[] }

/** The files whose name or lines have `query`, each with its lines, HIT_LIMIT lines at most in all. */
function inFiles(files: Files, query: string): Group[] {
  const groups: Group[] = [];
  let total = 0;
  for (const f of files) {
    if (total >= HIT_LIMIT) break;
    const hits = findInText(f.text, query, HIT_LIMIT - total);
    if (!hits.length && !nameMatches(f.path, query)) continue;
    groups.push({path: f.path, hits});
    total += hits.length;
  }
  return groups;
}

/**
 * What is found for `query` in the repo's `files`, its open `issues`, what `changed` and its `runs`: with a pill
 * pressed (`kind`), only what is of its kind; files are under no pill.
 */
export function search(query: string, kind: Kind | null, files: Files, issues: Issue[], changed: FileChange[], runs: Run[]): Found {
  const q = query.toLowerCase();
  const found = {
    issues: !kind || kind === 'issue' ? issues.filter((i) => `${issueName(i)} ${i.kind ?? ''}：${i.title}\n${i.detail}`.toLowerCase().includes(q)).slice(0, OTHER_LIMIT) : [],
    diffs: kind === 'diff' ? changed.filter((c) => c.path.toLowerCase().includes(q) || fileName(c.path).toLowerCase().includes(q)).slice(0, OTHER_LIMIT) : [],
    runs: !kind || kind === 'output' ? runs.slice().reverse().filter((r) => r.line.toLowerCase().includes(q) || r.output.toLowerCase().includes(q)).slice(0, OTHER_LIMIT) : [],
  };
  // An issue found is said once, as the issue (its number, kind and title), not again as its file's lines.
  const asIssue = new Set(found.issues.map((i) => issuePath(i)));
  return {...found, groups: kind ? [] : inFiles(files, query).filter((g) => !asIssue.has(g.path))};
}

/** What each thing found does when pressed. */
interface FoundWays {
  /** A file by its name: it is the one to work on, the caret in it. */
  file(path: string): void;
  /** A line found in a file. */
  line(path: string, line: number): void;
  /** A changed file: its diff, read under the box. */
  diff(path: string): void;
  issue(i: Issue): void;
  run(r: Run): void;
}

/**
 * A file found: its name, how many of its lines were found, its diff a press away if it changed since the last commit
 * (`c`), and each line found in it. Its name is a choice (↓ and Enter come to it) only when it holds the query
 * (`named`); found by its lines alone, the name is their head, pressed to open the file, and ↓ and Enter go to them.
 */
function fileGroup(g: Group, named: boolean, c: FileChange | undefined, ways: FoundWays, beat: (b: HTMLElement) => void): HTMLElement {
  // A file chosen by its name is the one to work on: the caret goes in it.
  const name = h('button', {type: 'button', class: named ? 'choice hit-file' : 'hit-file', ...(named ? {} : {tabindex: '-1'})}, shownPath(g.path));
  name.addEventListener('click', () => ways.file(g.path));
  // How many of its lines were found, in words beside its name: a count, never read as its diff's figures.
  const count = g.hits.length ? h('span', {class: 'hit-count'}, tn('{n} line', '{n} lines', g.hits.length)) : null;
  // Changed since the last commit: at the head's other end its diff, said as a diff is everywhere (diff, +n −n, the
  // squares), read under the box when pressed; not a stop of its own on the way down to the lines.
  const diff = c ? h('button', {type: 'button', class: 'hit-diff', tabindex: '-1', 'aria-label': t('Diff of {path}', {path: fileName(g.path)})},
    h('span', {class: 'hit-diff-word'}, t('diff')), c.added || c.removed ? counted(c.added, c.removed) : null) : null;
  diff?.addEventListener('click', () => ways.diff(g.path));
  return h('div', {class: 'hit-group'}, h('div', {class: 'hit-head'}, name, count, diff), ...g.hits.map((hit) => {
    const b = h('button', {type: 'button', class: 'choice hit'},
      h('span', {class: 'hit-line'}, String(hit.line)),
      h('span', {class: 'hit-text'}, ...tucked(hit.text.slice(0, hit.from)), h('mark', {}, ...tucked(hit.text.slice(hit.from, hit.to))), ...tucked(hit.text.slice(hit.to))));
    beat(b);
    b.addEventListener('click', () => ways.line(g.path, hit.line));
    return b;
  }));
}

/**
 * What was found for `query`, drawn: how many files and lines, then each file with its lines, the issues, the
 * changes (of what `changed`) and the runs. Nothing, when nothing was found. The first choice, which Enter takes from
 * the box, says so while the box has the keyboard: lit, with its key at its end.
 */
export function foundView(found: Found, query: string, changed: FileChange[], ways: FoundWays): HTMLElement[] {
  const {groups} = found;
  const total = groups.reduce((n, g) => n + g.hits.length, 0);
  const changes = new Map(changed.map((c) => [c.path, c]));
  const said: HTMLElement[] = [];
  if (groups.length) said.push(h('p', {class: 'muted small search-count'}, `${tn('{n} file', '{n} files', groups.length)} · ${total >= HIT_LIMIT ? t('{n} lines (first preview)', {n: total}) : tn('{n} line', '{n} lines', total)}`));
  // Each line found is drawn a beat after the one above it (styles.css .search-results mark).
  let stroke = 0;
  // Through the style object, not an attribute: the desktop app's policy allows no style written inline.
  const beat = (b: HTMLElement) => b.style.setProperty('--i', String(Math.min(stroke++, 16)));
  for (const g of nameFirst(groups, query)) said.push(fileGroup(g, nameMatches(g.path, query), changes.get(g.path), ways, beat));
  if (found.issues.length) said.push(h('div', {class: 'hit-group'}, h('h3', {class: 'hit-kind'}, t('Issue')), ...found.issues.map((i) => {
    const b = issueButton(i, query, ways.issue);
    beat(b);
    return b;
  })));
  if (found.diffs.length) said.push(h('div', {class: 'hit-group'}, h('h3', {class: 'hit-kind'}, t('diff')),
    ...found.diffs.map((c) => diffButton(c.path, counted(c.added, c.removed), ways.diff))));
  if (found.runs.length) said.push(h('div', {class: 'hit-group'}, h('h3', {class: 'hit-kind'}, t('Output')), ...found.runs.map((r) => runButton(r, ways.run))));
  const first = said.map((el) => el.querySelector<HTMLElement>('.choice')).find((b) => b);
  first?.classList.add('first');
  first?.append(h('kbd', {class: 'enter-cap', 'aria-hidden': 'true'}, 'Enter'));
  return said;
}
