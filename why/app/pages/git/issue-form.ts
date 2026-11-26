import {h} from '../../ui/dom.ts';
import {t} from '../../../text/i18n.ts';
import {saveIssue, writeIssue, type Issue} from '../../../repo/issues.ts';
import {kindOf, named} from '../../../repo/text.ts';
import {errorText} from '../../../api/errors.ts';
import {nudge} from '../../ui/glide.ts';
import {issueStore} from '../../../repo/issue-store.ts';
import './issue-writing.css';

/** An issue just made: its repo and its file. */
export interface Made { repo: string; file: string }

type Outcome = {file: string} | {error: string};
interface Draft {
  first: string;
  detail: string;
  error: string;
  pending: Promise<Outcome> | null;
}

const drafts = new Map<string, Draft>();
const blank = (): Draft => ({first: '', detail: '', error: '', pending: null});

/** What was written stays at its repo, never transplanted into another folder. */
export const drafted = (repo?: string | null) =>
  (repo === undefined ? [...drafts.values()] : [repo ? drafts.get(repo) : undefined])
    .some((d) => !!(d?.first.trim() || d?.detail.trim()));

/** The blank slot is the next sheet; its entry is outside the current issue (IssueRow). */
export function newIssue(now: boolean, repo: string | null, none: string, ways: {made(m: Made): void; back(): void}): HTMLElement {
  const card = h('div', {class: 'issue-card issue-new-card', 'data-draft-repo': repo ?? ''});
  if (!now) {
    card.classList.add('issue-new-unwritten');
    card.setAttribute('aria-hidden', 'true');
    return card;
  }
  const draft = repo ? drafts.get(repo) ?? blank() : blank();
  if (repo) drafts.set(repo, draft);

  const target = h('span', {class: 'issue-where', id: 'issue-target'}, repo ?? '');
  const line = h('input', {class: 'issue-first', placeholder: t('Issue title'),
    'aria-label': t('Issue title'), 'aria-describedby': target.id, maxlength: '200', autocomplete: 'off'}) as HTMLInputElement;
  const body = h('textarea', {class: 'issue-detail-draft', placeholder: t('Details'),
    'aria-label': t('Details'), maxlength: '4000', rows: '5'}) as HTMLTextAreaElement;
  const confirm = h('button', {type: 'submit', class: 'issue-create-word issue-create-submit'}, t('Create issue')) as HTMLButtonElement;
  const error = h('p', {class: 'error', role: 'alert'}, draft.error);
  const form = h('form', {class: 'issue-box no-work issue-create-form', novalidate: '', 'aria-label': t('New issue')},
    h('label', {class: 'issue-words issue-big-head'}, h('span', {class: 'issue-create-head'}, line)),
    body, error,
    h('div', {class: 'issue-create-foot'}, target, none ? h('span', {class: 'muted small'}, none) : null, confirm));
  card.append(form);
  line.value = draft.first;
  body.value = draft.detail;

  let composing = false;
  const sync = () => {
    const held = !!draft.pending;
    form.setAttribute('aria-busy', String(held));
    line.readOnly = body.readOnly = held;
    confirm.disabled = held || composing || !repo || !kindOf(line.value).title.trim();
    const back = card.closest('.issue-column')?.querySelector<HTMLButtonElement>('.issue-create-back');
    if (back) back.disabled = held;
    error.textContent = draft.error;
  };
  const writing = () => {
    if (draft.pending) return;
    draft.first = line.value;
    draft.detail = body.value;
    draft.error = '';
    sync();
  };
  const landed = () => {
    const slot = card.closest('.issue-slot');
    return card.isConnected && (!slot || slot.getAttribute('aria-current') === 'true');
  };
  const hear = (pending: Promise<Outcome>) => {
    void pending.then((result) => {
      // A repaint can replace the composer while main is writing. Only the one
      // still in hand can move to the result; a dismissed draft never steals focus.
      if (!landed() || !repo) return;
      if ('file' in result) ways.made({repo, file: result.file});
      else { sync(); line.focus({preventScroll: true}); }
    });
  };
  const make = () => {
    if (!repo || draft.pending || composing || !landed()) return;
    const {kind, title} = kindOf(line.value);
    if (!title.trim()) {
      draft.error = t('Enter a title on the first line');
      sync();
      return;
    }
    draft.first = line.value;
    draft.detail = body.value;
    draft.error = '';
    // Store shared by mounted and rebuilt views: one creation per repo draft.
    // A failed remote commit already leaves the local issue waiting in issueStore.
    draft.pending = writeIssue(issueStore, repo, kind, title, draft.detail).then((file) => {
      drafts.delete(repo);
      return {file};
    }, (e: unknown) => {
      draft.pending = null;
      draft.error = t('Failed to create: {message}', {message: errorText(e)});
      return {error: draft.error};
    });
    sync();
    hear(draft.pending);
  };
  form.addEventListener('input', writing);
  form.addEventListener('compositionstart', () => { composing = true; sync(); });
  form.addEventListener('compositionend', () => { composing = false; writing(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); make(); });
  form.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229 || composing) return;
    if (e.key === 'Enter' && e.target === line) { e.preventDefault(); make(); }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (!draft.pending) ways.back();
    }
  });
  sync();
  if (draft.pending) hear(draft.pending);
  return card;
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
