import {h} from '../../ui/dom.ts';
import {errorText} from '../../../api/errors.ts';
import {ago} from '../../../text/format.ts';
import {t, tn} from '../../../text/i18n.ts';
import * as git from '../../../repo/history.ts';
import {lineKey, markBasis} from '../../../api/review-lines.ts';
import {diffPaper} from './diff-paper.ts';
import {busy, held} from './held.ts';

type Revision = git.Revision;
type ReviewLine = git.ReviewLine;
type Editor = {text: string; marks: ReviewLine[]; open: boolean; request: string | null};
type Reading = {revision: Revision; linked: ReviewLine[]; back: Revision | null};
const idOf = (repo: string, id: string) => JSON.stringify([repo, id]);
const revisionKey = (repo: string, id: string, at: Revision) => JSON.stringify([repo, id, at.version, at.head]);
const same = (a: Revision, b: Revision) => a.version === b.version && a.head === b.head;
const edits = new Map<string, Editor>();
const readings = new Map<string, Reading>();
const diffs = new Map<string, git.FileDiff[]>();
const logs = new Map<string, git.Cut[]>();
const no = (word: string, cls = 'muted small') => h('p', {class: cls}, word);
const key = (name: string, cls = 'git-review-key') => h('button', {type: 'button', class: cls}, name) as HTMLButtonElement;

function bounded<V>(map: Map<string, V>, name: string, value: V) {
  map.delete(name);
  map.set(name, value);
  if (map.size > 48) map.delete(map.keys().next().value!);
}

export function hasApproval(change: git.Change): boolean {
  return change.reviews.some((r) => r.verdict === 'approve' && r.version === change.version &&
    (markBasis(r.version, r.marks)?.basis.head ?? change.head) === change.head);
}

export function readingLatest(repo: string, change: git.Change): boolean {
  const r = readings.get(idOf(repo, change.id));
  return !r || same(r.revision, change);
}

function getDraft(repo: string, id: string, at: Revision): Editor {
  const scope = revisionKey(repo, id, at);
  let next = edits.get(scope);
  if (!next) {
    next = {text: '', marks: [], open: false, request: null};
    edits.set(scope, next);
    if (edits.size > 48) {
      const empty = [...edits].find(([id, draft]) => id !== scope && !draft.text && !draft.marks.length && !draft.open);
      if (empty) edits.delete(empty[0]); // Never evict unsent words or strokes.
    }
  }
  return next;
}

/** Join contiguous marks into one link, never implying that lines between sparse marks are selected. */
function ranges(lines: readonly ReviewLine[]): {first: ReviewLine; last: number}[] {
  const ordered = [...new Map(lines.map((l) => [lineKey(l), l])).values()]
    .sort((a, b) => a.path.localeCompare(b.path) || Number(a.side === 'old') - Number(b.side === 'old') || a.line - b.line);
  const out: {first: ReviewLine; last: number}[] = [];
  for (const line of ordered) {
    const tail = out.at(-1);
    if (tail?.first.path === line.path && tail.first.side === line.side && tail.last + 1 === line.line) tail.last = line.line;
    else out.push({first: line, last: line.line});
  }
  return out;
}

const labelRef = ({first, last}: ReturnType<typeof ranges>[number]) =>
  first.path + ':' + first.line + (first.line === last ? '' : '–' + last) + (first.side === 'old' ? ' (' + t('Before') + ')' : '');

export interface ReviewParts {
  work: HTMLElement;
  foot: HTMLElement;
  history: HTMLElement;
}

export function issueReview(repo: string, change: git.Change, totals: HTMLElement, again: () => void): ReviewParts {
  let latest = change;
  let at: Revision = readings.get(idOf(repo, change.id))?.revision ?? change;
  let linked = readings.get(idOf(repo, change.id))?.linked ?? [];
  let back = readings.get(idOf(repo, change.id))?.back ?? null;
  let currentFiles: git.FileDiff[] | null = null;
  let paper: ReturnType<typeof diffPaper> | null = null;
  let selectSeq = 0;
  let commits = logs.get(JSON.stringify([repo, change.line])) ?? [];
  let commentError = '';
  let using = false;
  let approveRequest: string | null = null;
  const sc = () => revisionKey(repo, change.id, at);
  const draft = () => getDraft(repo, change.id, at);
  const writable = () => latest.state === 'open' && same(at, latest) && currentFiles !== null;
  const work = h('div', {class: 'git-work'}, no(t('Loading…')));
  const history = h('section', {class: 'git-history', 'aria-label': t('Commits')});
  const list = h('ol', {class: 'git-events'});
  const composer = h('div', {class: 'git-compose', hidden: ''});
  const labels = h('div', {class: 'git-comment-refs'});
  const error = h('p', {class: 'git-review-error error', role: 'alert'});
  const text = h('textarea', {class: 'git-review-text', 'aria-label': t('Comment'), placeholder: t('Add a comment…'), maxlength: '2000', rows: '2', spellcheck: 'false'}) as HTMLTextAreaElement;
  composer.append(h('label', {}, t('Comment')), text, labels);
  history.append(list, composer, error);
  const comment = key(t('Comment'), 'git-review-key git-review-comment');
  comment.dataset.gitFocus = 'comment';
  const approve = key(t('Approve'), 'git-review-key git-review-approve');
  approve.dataset.gitFocus = 'approve';
  const foot = h('div', {class: 'git-paper-review'}, comment, approve);
  function saveReading() { bounded(readings, idOf(repo, latest.id), {revision: at, linked, back}); }
  function draftRefs() { labels.replaceChildren(...ranges(draft().marks).map((r) => h('span', {}, labelRef(r)))); }
  function syncActs() {
    const active = writable();
    comment.disabled = !active;
    approve.disabled = !active || hasApproval(latest);
    approve.classList.toggle('approved', hasApproval(latest) && same(at, latest));
    foot.hidden = latest.state !== 'open';
    composer.hidden = !active || !draft().open;
    if (text.value !== draft().text) text.value = draft().text;
    error.textContent = commentError;
    draftRefs();
  }
  function clearRead() { linked = []; back = null; saveReading(); }

  function show(files: git.FileDiff[], reveal: ReviewLine | undefined) {
    currentFiles = files;
    const isCurrent = writable();
    const view = diffPaper(files, {key: sc(), marks: draft().marks, linked,
      ...(isCurrent ? {onMarks(lines: ReviewLine[]) {
        clearRead();
        const active = draft();
        active.marks = lines;
        active.request = null;
        draftRefs();
      }} : {})});
    paper = view;
    work.replaceChildren(files.length ? view.element : no(t('No changes')),
      ...(files.some((file) => file.approximate) ? [no(t('Some line positions are unavailable in this comparison'))] : []));
    gitTotals(totals, files);
    syncActs();
    if (reveal) requestAnimationFrame(() => { if (paper === view && !view.reveal(reveal)) {
      commentError = t('This marked line is not in the visible diff');
      syncActs();
    } });
  }

  function read(next: Revision, refs: ReviewLine[] = [], returnTo: Revision | null = null) {
    const seq = ++selectSeq;
    const come = (got: git.FileDiff[]) => {
      if (seq !== selectSeq) return;
      if (refs.length && !refs.every((ref) => got.some((file) => file.path === ref.path && !file.binary &&
          file.lines.some((l) => l.kind !== 'hunk' && l.text.trim() &&
            (ref.side === 'old' ? l.old : l.new) === ref.line)))) {
        commentError = t('This marked line is not in the visible diff');
        syncActs();
        return;
      }
      at = next; linked = refs; back = returnTo;
      saveReading();
      commentError = '';
      show(got, refs[0]);
      drawHistory();
    };
    const name = revisionKey(repo, change.id, next), cached = diffs.get(name);
    if (cached) { come(cached); return Promise.resolve(); }
    return git.changeDiffAt(repo, latest.id, next).then((got) => {
      bounded(diffs, name, got);
      come(got);
    }, (e) => {
      if (seq !== selectSeq) return;
      commentError = errorText(e);
      if (!currentFiles) work.replaceChildren(no(commentError, 'error'));
      syncActs();
    });
  }

  function drawHistory() {
    const grouped = new Map<number, {revision: Revision | null; reviews: git.Review[]}>();
    grouped.set(latest.version, {revision: latest, reviews: []});
    for (const review of latest.reviews) {
      const pin = markBasis(review.version, review.marks);
      const row = grouped.get(review.version) ?? {revision: pin?.basis ?? null, reviews: []};
      if (!row.revision && pin) row.revision = pin.basis;
      row.reviews.push(review);
      grouped.set(review.version, row);
    }
    if (!grouped.has(at.version)) grouped.set(at.version, {revision: at, reviews: []});
    const byVersion = [...grouped].sort(([a], [b]) => b - a);
    list.replaceChildren(...byVersion.map(([n, group]) => {
      const revision = group.revision;
      const heading = revision ? key(t('Version {n}', {n}), 'git-history-version') : h('span', {}, t('Version {n}', {n}));
      if (heading instanceof HTMLButtonElement && revision) {
        heading.dataset.gitFocus = 'revision-' + n;
        heading.setAttribute('aria-current', String(same(at, revision)));
        heading.addEventListener('click', () => void read(revision).then(() =>
          list.querySelector<HTMLElement>(`[data-git-focus="revision-${n}"]`)?.focus({preventScroll: true})));
      }
      const words = group.reviews.map((r) => {
        const pin = markBasis(n, r.marks);
        const tail = pin && ranges(pin.lines).map((range) => {
          const name = labelRef(range), chosen = pin.lines.filter((l) => l.path === range.first.path && l.side === range.first.side &&
              l.line >= range.first.line && l.line <= range.last);
          // Button rendered as an address: the target is in this desk, not a URL to an unrelated site.
          const b = key(name, 'git-history-ref');
          b.dataset.gitRef = (r.id ?? String(r.time)) + ':' + lineKey(range.first);
          b.setAttribute('role', 'link');
          b.addEventListener('click', () => void read(pin.basis, chosen, back ?? at));
          return b;
        });
        const action = r.verdict === 'approve' ? t('Approved by {who}', {who: r.by}) :
          r.verdict === 'changes' ? r.by + ' · ' + t('Changes requested') : r.by;
        return h('li', {class: 'git-history-comment'},
          h('p', {class: 'git-history-who'}, action || '—', ' · ', ago(r.time)),
          r.note ? h('p', {class: 'git-history-words'}, r.note) : null,
          ...tail ?? []);
      });
      // Both the offered tip and the current work log are real. Do not make the newer, unsubmitted
      // commits look like part of an earlier offer.
      const tip = n === latest.version ? commits.findIndex((c) => c.id === latest.head) : -1;
      const own = tip < 0 ? [] : commits.slice(tip);
      const base = own.findIndex((c) => c.id === latest.base);
      const shown = base < 0 ? own : own.slice(0, base);
      return h('li', {class: 'git-history-version-row'}, heading,
        words.length ? h('ol', {class: 'git-history-review-list'}, ...words) : null,
        ...shown.map((c) => h('div', {class: 'git-history-commit'}, h('code', {}, c.id.slice(0, 8)), c.title)));
    }));
    if (back) {
      const go = key(t('Back'), 'git-history-version git-history-return');
      go.addEventListener('click', () => { const previous = back; if (previous) void read(previous); });
      list.append(h('li', {}, go));
    }
  }

  const record = async (verdict: 'comment' | 'approve') => {
    const trigger = verdict === 'comment' ? comment : approve;
    if (!writable() || using || held(trigger)) return;
    const active = draft();
    const message = verdict === 'comment' ? active.text.trim() : '';
    if (verdict === 'comment' && !message) { text.focus(); return; }
    using = true; busy(trigger, true); commentError = ''; syncActs();
    const request = verdict === 'comment' ? (active.request ??= crypto.randomUUID()) : (approveRequest ??= crypto.randomUUID());
    const sending = verdict === 'comment' ? active.marks.slice() : [];
    const sentAt = at;
    let next: git.Change;
    try {
      next = await git.reviewAt(repo, latest, verdict, request, message, sending);
    } catch (e) {
      commentError = errorText(e);
      using = false; busy(trigger, false); syncActs();
      return;
    }
    latest = next; // Keep the server's actual review, even if the next page read has not finished.
    if (verdict === 'comment') {
      if (active.request === request) {
        active.text = ''; active.marks = []; active.open = false; active.request = null;
      } else {
        // A new edit made while the answer was on its way is still a draft, not part of this comment.
        const recorded = new Set(sending.map(lineKey));
        active.marks = active.marks.filter((m) => !recorded.has(lineKey(m)));
      }
      if (same(at,sentAt)) { linked = []; back = null; saveReading(); }
    } else approveRequest = null;
    using = false; busy(trigger, false);
    if (currentFiles) show(currentFiles, undefined);
    drawHistory(); syncActs();
    if (verdict === 'approve') again(); else comment.focus({preventScroll:true});
  };
  comment.addEventListener('click', () => {
    if (!writable() || using) return;
    if (draft().open && text.value.trim()) { void record('comment'); return; }
    draft().open = true; syncActs(); text.focus();
  });
  approve.addEventListener('click', () => void record('approve'));
  text.addEventListener('input', () => { draft().text = text.value; draft().request = null; });
  text.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void record('comment'); }
    if (e.key === 'Escape') { e.preventDefault(); draft().open = false; syncActs(); comment.focus({preventScroll: true}); }
  });
  work.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && back && !e.defaultPrevented) {
      e.preventDefault();
      const previous = back;
      void read(previous).then(() => list.querySelector<HTMLElement>(`[data-git-focus="revision-${previous.version}"]`)?.focus({preventScroll: true}));
    }
  });
  syncActs();
  drawHistory();
  void read(at, linked, back);
  void git.logOf(repo, change.line).then((got) => {
    commits = got; bounded(logs, JSON.stringify([repo, change.line]), got);
    drawHistory();
  }, (e) => { if (!commentError) { commentError = errorText(e); syncActs(); } });
  return {work, foot, history};
}

export function gitTotals(to: HTMLElement, files: readonly git.FileDiff[]) {
  const add = files.reduce((n, f) => n + (f.added ?? f.lines.filter((l) => l.kind === 'add').length), 0);
  const del = files.reduce((n, f) => n + (f.removed ?? f.lines.filter((l) => l.kind === 'del').length), 0);
  to.replaceChildren(
    h('div', {class: 'git-total-numbers'}, add ? h('span', {class: 'diff-add'}, '+' + add) : null, del ? h('span', {class: 'diff-del'}, '−' + del) : null),
    ...(files.length ? [h('p', {class: 'git-total-files'}, tn('{n} file changed', '{n} files changed', files.length))] : []));
}
