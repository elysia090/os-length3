import {h} from '../../ui/dom.ts';
import {t} from '../../../text/i18n.ts';
import {saveIssue, writeIssue, type Issue} from '../../../repo/issues.ts';
import {kindOf, named} from '../../../repo/text.ts';
import {errorText} from '../../../api/errors.ts';
import {nudge} from '../../ui/glide.ts';
import {issueStore} from '../../../repo/issue-store.ts';

// Writing an issue is writing its first line where it stands (DESIGN §7: what is written is kept as it is written,
// nothing to open first, nothing to confirm). A line under main's sheet is always there, named as a TODO item is
// ("Fix: Title"), the repo it goes in said quietly over it: chosen in Git's one row of repos (All only widens what is
// shown, and leaves where it goes as it was). Enter makes it, and the keyboard goes on into its summary in the issue in
// full, where it is written on and kept as it is left. What is half written stays in the line, going along the row or
// to another page and back.
//
// Its title is changed where it is read, the same way: pressed, it is written over in its place, its kind kept and
// its words chosen; Enter or leaving keeps what is written, Escape puts it back.

/** An issue just made: its repo and its file. */
export interface Made { repo: string; file: string }

/** The new issue's line as it was left: what is written, and where it goes. */
let draft: {text: string; repo: string | null} = {text: '', repo: null};

export interface IssueLine {
  element: HTMLElement;
  /** Write in `repo` from now on (chosen in the row above), what is written kept. */
  retarget(repo: string): void;
  /** Whether there is anywhere to write it (a repo). */
  enable(on: boolean): void;
  /** The repos read: where it goes (`to`, the repo shown). */
  arrived(to: string | null): void;
  /** Something is written in it. */
  readonly writing: boolean;
  /** The keyboard back in it, at the end of what is written. */
  focus(): void;
}

/** The line a new issue is written on; `made` hears what was made. */
export function issueLine(events: {made(m: Made): void}): IssueLine {
  const where = h('span', {class: 'issue-where', id: 'issue-target'});
  const line = h('input', {class: 'line-in issues-line', placeholder: t('Fix: Title'), 'aria-label': t('First line: Type: Title'),
    'aria-describedby': 'issue-target', maxlength: '200', spellcheck: 'false', autocomplete: 'off'}) as HTMLInputElement;
  const error = h('p', {class: 'error', role: 'alert'});
  const element = h('div', {class: 'issues-new'}, where, line, error);
  line.value = draft.text;
  let target: string | null = draft.repo;
  const say = () => { where.textContent = target ?? ''; where.title = target ?? ''; };
  say();
  line.addEventListener('input', () => { draft.text = line.value; if (error.textContent) error.textContent = ''; });
  let making = false;
  const make = async () => {
    if (making || !target) return;
    const {kind, title} = kindOf(line.value);
    if (!title.trim()) { error.textContent = t('Enter a title on the first line'); nudge(line); return; }
    making = true;
    const repo = target;
    try {
      const file = await writeIssue(issueStore, repo, kind, title, '');
      line.value = '';
      draft = {text: '', repo};
      events.made({repo, file});
    } catch (e) { error.textContent = t('Failed to create: {message}', {message: errorText(e)}); } finally { making = false; }
  };
  line.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); void make(); }
  });
  return {
    element,
    retarget: (repo) => { target = repo; draft.repo = repo; say(); },
    enable: (on) => { line.disabled = !on; },
    arrived: (to) => {
      target = to;
      draft.repo = to;
      say();
    },
    get writing() { return !!line.value.trim(); },
    focus: () => { line.focus({preventScroll: true}); line.setSelectionRange(line.value.length, line.value.length); },
  };
}

/** An issue's title being written over, by repo/file: kept while the page is drawn again under it. */
const changing = new Map<string, string>();
const keyOf = (i: Issue) => `${i.repo}/${i.file}`;

/**
 * `words` (the press that holds an issue's head, as it is read) written over in its place: its first line as it was
 * written ("Fix：Title"), the title chosen and the kind kept. Enter or leaving keeps what is written, with the summary
 * as it stands (`detail`), and `after` draws the page again; Escape, nothing written or the same line put it back
 * (`back`, the head as it was). A failure is said in `error`, the line kept to be written on.
 */
export function retitle(issue: Issue, words: HTMLElement, head: HTMLElement, detail: () => string, error: HTMLElement, after: () => void, focus = true) {
  const key = keyOf(issue);
  const was = named(issue.kind, issue.title);
  const text = h('span', {class: 'issue-retitle', contenteditable: 'plaintext-only', role: 'textbox', 'aria-label': t('First line: Type: Title'), spellcheck: 'false'});
  text.textContent = changing.get(key) ?? was;
  const no = head.querySelector('.issue-no')?.cloneNode(true) ?? null;
  const edit = h('div', {class: 'issue-words issue-big-head editing'}, h('h2', {}, no, no ? ' ' : null, text));
  words.replaceWith(edit);
  let over = false;
  const back = (refocus: boolean) => {
    if (over) return;
    over = true;
    changing.delete(key);
    edit.replaceWith(words);
    if (refocus) words.focus({preventScroll: true});
  };
  text.addEventListener('input', () => { changing.set(key, text.textContent ?? ''); if (error.textContent) error.textContent = ''; });
  const keep = async (leaving: boolean) => {
    if (over) return;
    const written = (text.textContent ?? '').trim();
    const {kind, title} = kindOf(written);
    if (!title.trim() || written === was) { back(!leaving); return; }
    over = true;
    try {
      await saveIssue(issueStore, issue, kind, title, detail());
      changing.delete(key);
      after();
    } catch (e) {
      over = false;
      error.textContent = t('Failed to create: {message}', {message: errorText(e)});
      if (!leaving) text.focus();
      nudge(text);
    }
  };
  text.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); void keep(false); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); back(true); }
  });
  text.addEventListener('blur', () => void keep(true));
  if (!focus) return;
  text.focus({preventScroll: true});
  // The title chosen, its kind kept before it: what is typed writes a new title.
  const node = text.firstChild, at = Math.max(0, (text.textContent ?? '').indexOf('：') + 1);
  if (node) {
    const r = document.createRange();
    r.setStart(node, at);
    r.setEnd(node, (text.textContent ?? '').length);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(r);
  }
}

/** Whether `issue`'s title is being written over (its box then opens with it, as it was). */
export const beingChanged = (issue: Issue) => changing.has(keyOf(issue));
