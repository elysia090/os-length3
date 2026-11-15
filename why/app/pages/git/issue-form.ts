import {h} from '../../ui/dom.ts';
import {t} from '../../../text/i18n.ts';
import {saveIssue, writeIssue, type Issue} from '../../../repo/issues.ts';
import {kindOf, named} from '../../../repo/text.ts';
import {errorText} from '../../../api/errors.ts';
import {nudge} from '../../ui/glide.ts';
import {issueStore} from '../../../repo/issue-store.ts';

// Writing an issue is writing its first line where it stands (DESIGN §7: what is written is kept as it is written,
// nothing to confirm). The issue not written yet is the last piece of Git's row, where a new thing in a row always is
// (a new board at a server's row's end): beside the one in full only its edge, its + and its name; in the hand, the
// issue it will be, its first line written in its head in an issue title's letters, named as a TODO item is ("Fix:
// Title"), the repo it goes in said quietly at its foot, as a card says its repo (chosen in Git's one row of repos; All
// only widens what is shown, and leaves where it goes as it was). Enter makes it, and the keyboard goes on into its
// summary in the issue in full, where it is written on and kept as it is left; Escape with nothing written goes back to
// the issue before it. What is half written stays, going along the row or to another page and back. (Before, it was a
// line always there under main's steps: a second thing on that sheet, read as part of its Start.)
//
// Its title is changed where it is read, the same way: pressed, it is written over in its place, its kind kept and
// its words chosen; Enter or leaving keeps what is written, Escape puts it back.

/** An issue just made: its repo and its file. */
export interface Made { repo: string; file: string }

/** The new issue's first line as it was left. */
let draft = '';

/** Something is written on the new issue's first line. */
export const drafted = () => !!draft.trim();

/**
 * The issue not written yet, as the row's last slot holds it: in the hand (`now`) the issue it will be, going into
 * `repo`, with what is so said quietly at its foot (`none`: no issue yet); else its edge. `made` hears what was made;
 * `back` goes to the issue before it.
 */
export function newIssue(now: boolean, repo: string | null, none: string, ways: {made(m: Made): void; back(): void}): HTMLElement {
  const head = (...words: (Node | string)[]) => h('div', {class: 'issue-card issue-new-card'}, ...words);
  if (!now) return head(h('div', {class: 'issue-big-head peek'}, h('h2', {}, h('span', {class: 'issue-no'}, '+'), ' ', t('New issue'))));
  const line = h('input', {class: 'issue-first', placeholder: t('Fix: Title'), 'aria-label': t('First line: Type: Title'),
    'aria-describedby': 'issue-target', maxlength: '200', spellcheck: 'false', autocomplete: 'off'}) as HTMLInputElement;
  line.value = draft;
  const error = h('p', {class: 'error', role: 'alert'});
  line.addEventListener('input', () => { draft = line.value; if (error.textContent) error.textContent = ''; });
  let making = false;
  const make = async () => {
    if (making || !repo) return;
    const {kind, title} = kindOf(line.value);
    if (!title.trim()) { error.textContent = t('Enter a title on the first line'); nudge(line); return; }
    making = true;
    try {
      const file = await writeIssue(issueStore, repo, kind, title, '');
      draft = '';
      ways.made({repo, file});
    } catch (e) { error.textContent = t('Failed to create: {message}', {message: errorText(e)}); } finally { making = false; }
  };
  line.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); void make(); }
    if (e.key === 'Escape' && !line.value.trim()) { e.preventDefault(); ways.back(); }
  });
  // Its name over its corner, as every piece has one (quiet: it is not an issue yet).
  return head(h('div', {class: 'issue-box no-work'}, h('p', {class: 'issue-name', 'aria-hidden': 'true'}, t('New issue')),
    h('label', {class: 'issue-words issue-big-head'}, h('h2', {}, line)), error,
    h('div', {class: 'issue-foot'}, h('div', {class: 'issue-about'}, h('span', {class: 'issue-where', id: 'issue-target'}, repo ?? ''),
      none ? h('span', {class: 'muted small'}, none) : null))));
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
