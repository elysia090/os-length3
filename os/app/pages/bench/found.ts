import {h} from '../../ui/dom.ts';
import type {FileChange} from '../../repos/history.ts';
import {issueName, issuePath, shownPath, type Issue} from '../../repos/issues.ts';
import {t, tn} from '../../i18n/i18n.ts';
import {inPieces, store, walkRepo, type Change} from '../../repos/repos.ts';
import {findInText, nameFirst, nameMatches, type Hit} from '../../repos/search.ts';
import type {Run} from './sessions.ts';
import {kindColon} from '../kit/todo-list.ts';
import {counted, fileName} from '../kit/diff-view.ts';
import {askButton, diffButton, issueButton, runButton, type Kind} from './kinds.ts';
import type {Ask} from './asks.ts';

// What a search under the box finds in the repo: its files and the lines in them, and of the pill pressed (or of
// all of them) its issues, its changes, its runs and what was asked of its Agent.

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
  const files = (await walkRepo(repo, {shown: true})).filter((f) => f.entry.kind === 'file');
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

/** What was found: the files with the lines found in them, and the issues, changes, runs and asks of the Agent. */
interface Found { groups: Group[]; issues: Issue[]; diffs: FileChange[]; runs: Run[]; asks: Ask[] }

/** A text lowercased, kept with what holds it (a file as read for the search, a run) while it is the same: a key typed
 * searches it again. */
const lowered = new WeakMap<object, string>();
function lowOf(o: object, text: string): string {
  let low = lowered.get(o);
  if (low === undefined) lowered.set(o, low = text.toLowerCase());
  return low;
}

/** What a run printed, lowercased, kept with the run while what it printed is the same (it grows while it runs). */
const printed = new WeakMap<Run, {text: string; low: string}>();
function outputLow(r: Run): string {
  const was = printed.get(r);
  if (was && was.text === r.output) return was.low;
  const low = r.output.toLowerCase();
  printed.set(r, {text: r.output, low});
  return low;
}

/** How long one stretch of going through the files may hold the page, in ms: past it the page draws and takes keys. */
const SLICE = 3;
/** The page given back for a moment (what it waits to do, a key typed, is done first). */
const toPage = () => new Promise<void>((done) => { const c = new MessageChannel(); c.port1.onmessage = () => done(); c.port2.postMessage(0); });

/** The last search gone through every file to the end: its words, the files it went through, and those holding them
 * (in their name or a line). Words that go on from them are in no other file: only those are gone through again. */
let through: {files: Files; query: string; holding: Files} | null = null;

/**
 * The files whose name or lines have `query`, each with its lines, HIT_LIMIT lines at most in all; null if `stale`
 * says, at a break, that it is no longer wanted. Gone through a few ms at a time, the page between.
 */
async function inFiles(files: Files, query: string, stale: () => boolean): Promise<Group[] | null> {
  const q = query.toLowerCase();
  const pool = through && through.files === files && q.startsWith(through.query) ? through.holding : files;
  const groups: Group[] = [], holding: Files = [];
  let total = 0, since = performance.now();
  for (const f of pool) {
    if (total >= HIT_LIMIT) break;
    if (performance.now() - since > SLICE) {
      await toPage();
      if (stale()) return null;
      since = performance.now();
    }
    const hits = findInText(f.text, query, HIT_LIMIT - total, lowOf(f, f.text));
    if (!hits.length && !nameMatches(f.path, query)) continue;
    holding.push(f);
    groups.push({path: f.path, hits});
    total += hits.length;
  }
  if (total < HIT_LIMIT) through = {files, query: q, holding};
  return groups;
}

/**
 * What is found for `query` in the repo's `files`, its open `issues`, what `changed`, its `runs` and what was asked of
 * its Agent (`asks`: the question, its steps and its words): with a pill pressed (`kind`), only what is of its kind;
 * files are under no pill. Null once `stale` (a newer search under way).
 */
export async function search(query: string, kind: Kind | null, files: Files, issues: Issue[], changed: FileChange[], runs: Run[], asks: Ask[] = [],
  stale: () => boolean = () => false): Promise<Found | null> {
  const q = query.toLowerCase();
  const found = {
    issues: !kind || kind === 'issue' ? issues.filter((i) => `${issueName(i)} ${i.kind ?? ''}：${i.title}\n${i.detail}`.toLowerCase().includes(q)).slice(0, OTHER_LIMIT) : [],
    diffs: kind === 'diff' ? changed.filter((c) => c.path.toLowerCase().includes(q) || fileName(c.path).toLowerCase().includes(q)).slice(0, OTHER_LIMIT) : [],
    runs: !kind || kind === 'output' ? runs.slice().reverse().filter((r) => r.line.toLowerCase().includes(q) || outputLow(r).includes(q)).slice(0, OTHER_LIMIT) : [],
    asks: !kind || kind === 'agent' ? asks.slice().reverse().filter((a) => [a.question, ...a.parts.map((p) => p.text)].some((x) => x.toLowerCase().includes(q))).slice(0, OTHER_LIMIT) : [],
  };
  // An issue found is said once, as the issue (its number, kind and title), not again as its file's lines.
  const asIssue = new Set(found.issues.map((i) => issuePath(i)));
  if (kind) return {...found, groups: []};
  const groups = await inFiles(files, query, stale);
  return groups && {...found, groups: groups.filter((g) => !asIssue.has(g.path))};
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
  ask(a: Ask): void;
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

/** `text` with `query` marked wherever it is in it (as written, whatever its case). */
function marked(text: string, query: string): (Node | string)[] {
  const low = text.toLowerCase(), q = query.toLowerCase(), parts: (Node | string)[] = [];
  let i = 0;
  for (let at = q ? low.indexOf(q) : -1; at >= 0; at = low.indexOf(q, i)) {
    parts.push(text.slice(i, at), h('mark', {}, text.slice(at, at + q.length)));
    i = at + q.length;
  }
  parts.push(text.slice(i));
  return parts;
}

/** A run as a line of the sheet: `$`, then its line as typed (its first), `query` marked wherever it is in it. */
function runLine(r: Run, query: string, read: (r: Run) => void): HTMLElement {
  const b = h('button', {type: 'button', class: 'choice run-line'}, h('span', {class: 'run-ps', 'aria-hidden': 'true'}, '$'),
    h('span', {class: 'run-text'}, ...marked(r.line.split('\n')[0], query)));
  b.addEventListener('click', () => read(r));
  return b;
}

/**
 * The files found, as the band's sheet says them: a row a thing found, read across. A file whose name holds the query
 * is a row of its own, its name marked where it does; each line found is a row of its file's name, the line's number
 * and its words, `query` marked in them. No count of lines nor diff beside a name: the sheet is what was found.
 */
function fileRows(groups: Group[], query: string, ways: FoundWays, beat: (b: HTMLElement) => void): HTMLElement[] {
  return nameFirst(groups, query).flatMap((g) => {
    const shown = shownPath(g.path), rows: HTMLElement[] = [];
    if (nameMatches(g.path, query)) {
      const b = h('button', {type: 'button', class: 'choice sheet-hit sheet-name'}, h('span', {class: 'sheet-file'}, ...marked(shown, query)));
      b.addEventListener('click', () => ways.file(g.path));
      beat(b);
      rows.push(b);
    }
    for (const hit of g.hits) {
      const b = h('button', {type: 'button', class: 'choice sheet-hit'},
        h('span', {class: 'sheet-file'}, shown),
        h('span', {class: 'sheet-line'}, String(hit.line)),
        h('span', {class: 'sheet-text'}, ...tucked(hit.text.slice(0, hit.from)), h('mark', {}, ...tucked(hit.text.slice(hit.from, hit.to))), ...tucked(hit.text.slice(hit.to))));
      b.addEventListener('click', () => ways.line(g.path, hit.line));
      beat(b);
      rows.push(b);
    }
    return rows;
  });
}

/**
 * What was found for `query`, drawn: how many files and lines, then each file with its lines, the issues, the
 * changes (of what `changed`) and the runs. Nothing, when nothing was found. The first choice, which Enter takes from
 * the box, says so while the box has the keyboard: lit, with its key at its end. In `sections` (the band's sheet),
 * each kind is a section, its name and how many at its left and what was found of it at its right, side by side two
 * to a row; no count above them.
 */
export function foundView(found: Found, query: string, changed: FileChange[], ways: FoundWays, o: {sections?: boolean} = {}): HTMLElement[] {
  const {groups} = found;
  const total = groups.reduce((n, g) => n + g.hits.length, 0);
  const changes = new Map(changed.map((c) => [c.path, c]));
  // Each line found is drawn a beat after the one above it (styles.css .search-results mark).
  let stroke = 0;
  // Through the style object, not an attribute: the desktop app's policy allows no style written inline.
  const beat = (b: HTMLElement) => b.style.setProperty('--i', String(Math.min(stroke++, 16)));
  /** Each kind found: its name, how many, and what of it there is. */
  const kinds: {name: string; n: number; rows: HTMLElement[]; files?: true}[] = [];
  if (groups.length) {
    // In the sheet, how many rows it found (a name, a line), as each other kind counts its rows; else how many files.
    const rows = o.sections ? fileRows(groups, query, ways, beat) : nameFirst(groups, query).map((g) => fileGroup(g, nameMatches(g.path, query), changes.get(g.path), ways, beat));
    kinds.push({files: true, name: t('files'), n: rows.length, rows});
  }
  if (found.issues.length) kinds.push({name: t('Issue'), n: found.issues.length, rows: found.issues.map((i) => { const b = issueButton(i, query, ways.issue); beat(b); return b; })});
  if (found.diffs.length) kinds.push({name: t('diff'), n: found.diffs.length, rows: found.diffs.map((c) => diffButton(c.path, counted(c.added, c.removed), ways.diff))});
  if (found.runs.length) {
    kinds.push(o.sections
      // In the sheet, a run as its line was typed, after the shell's $, what was searched for marked in it.
      ? {name: t('runs'), n: found.runs.length, rows: found.runs.map((r) => { const b = runLine(r, query, ways.run); beat(b); return b; })}
      : {name: t('Output'), n: found.runs.length, rows: found.runs.map((r) => runButton(r, ways.run))});
  }
  if (found.asks.length) kinds.push({name: t('Agent'), n: found.asks.length, rows: found.asks.map((a) => askButton(a, ways.ask))});
  const said: HTMLElement[] = [];
  if (o.sections) {
    if (kinds.length) said.push(h('div', {class: 'found-secs'}, ...kinds.map((k) => h('section', {class: 'found-sec', 'aria-label': k.name},
      h('h3', {class: 'found-sec-head'}, k.name, h('i', {}, String(k.n))), h('div', {class: 'found-sec-rows'}, ...k.rows)))));
  } else {
    if (groups.length) said.push(h('p', {class: 'muted small search-count'}, `${tn('{n} file', '{n} files', groups.length)} · ${total >= HIT_LIMIT ? t('{n} lines (first preview)', {n: total}) : tn('{n} line', '{n} lines', total)}`));
    for (const k of kinds) {
      if (k.files) said.push(...k.rows);
      else said.push(h('div', {class: 'hit-group'}, h('h3', {class: 'hit-kind'}, k.name), ...k.rows));
    }
  }
  const first = said.map((el) => el.querySelector<HTMLElement>('.choice')).find((b) => b);
  first?.classList.add('first');
  if (!o.sections) first?.append(h('kbd', {class: 'enter-cap', 'aria-hidden': 'true'}, 'Enter'));
  return said;
}
