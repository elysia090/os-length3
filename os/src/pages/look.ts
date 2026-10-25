import {ago, h} from '../dom.ts';
import {errorText} from '../errors.ts';
import {keepOut, pop, putAway} from '../glide.ts';
import {t} from '../i18n.ts';
import {mark} from '../icons.ts';
import * as inbox from '../inbox.ts';
import {issueName, readIssues, saveIssue, type Issue} from '../issues.ts';
import {look as lookForNews} from '../news.ts';
import {store} from '../repos.ts';
import * as servers from '../servers.ts';
import {getState, setState} from '../state.ts';
import * as todo from '../todo.ts';
import {answers} from './common.ts';
import {kindWords, mark as todoMark} from './todo-box.ts';

// A row in a pane (word from someone, where one left off, a board's new posts, a line the box wrote in the Prompt's
// flow) is not a door to another page: pressed, it opens where it stands (DESIGN.md § The right pane). One reaction:
// the row is lit and a card comes out from it, under it (over it, near the foot), holding what can be done right
// there: a conversation's last lines and a reply, a board's last posts and a post, the lines one left off at, an
// issue's summary, a TODO's mark. The way to its page is the card's last deed, at its right. One card at a time;
// Escape, a press outside it, its × or the row again put it away, and the keyboard goes back to the row.

/** What a row opens into. */
export interface Look {
  /** What it is, at the card's head: who wrote, the board, the file, the issue, the TODO. */
  title: string;
  /** What can be done there, put into `body` (read as it comes); `close` puts the card away. */
  fill(body: HTMLElement, close: () => void): void | Promise<void>;
  /** The way to its page, the card's last deed. */
  open: {word: string; go(): void};
  /** Told as it goes, whatever put it away (a summary half written is saved then). */
  closing?(): void;
}

/** The card out now and the row it came from. */
let out: {row: HTMLElement; close(back: boolean): void} | null = null;

const button = (text: string, kind = '') => h('button', {type: 'button', class: `button small-button ${kind}`.trim()}, text) as HTMLButtonElement;

/** Where the card stands: as wide as the pane the row is in, under the row, or over it when there is no room under. */
function place(card: HTMLElement, row: HTMLElement) {
  const r = row.getBoundingClientRect();
  const lane = (row.closest('.side, .home-side') ?? row).getBoundingClientRect();
  const pad = 16, width = Math.min(Math.max(lane.width - 2 * pad, 260), innerWidth - 16);
  const left = Math.max(8, Math.min(lane.left + pad, innerWidth - 8 - width));
  const high = card.offsetHeight, under = innerHeight - r.bottom - 8, over = r.top - 8;
  const below = under >= high + 6 || under >= over;
  card.style.left = `${left}px`;
  card.style.width = `${width}px`;
  card.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - high)}px`;
  card.style.maxHeight = `${Math.max(160, below ? under - 6 : over - 6)}px`;
  // It comes out of the row: from above it when under it, from below when over it.
  card.style.setProperty('--from', below ? '0 -6px' : '0 6px');
  card.style.transformOrigin = below ? 'top center' : 'bottom center';
}

/** `row` opens into `look`; pressed again while it is out, it is put away. */
export function lookFrom(row: HTMLElement, look: Look) {
  if (out?.row === row) { out.close(true); return; }
  out?.close(false);
  const body = h('div', {class: 'look-body'});
  const shut = h('button', {type: 'button', class: 'look-shut', 'aria-label': t('Put away')}, mark('close')) as HTMLButtonElement;
  const open = button(look.open.word, 'primary');
  const card = h('section', {class: 'pop look', role: 'dialog', 'aria-label': look.title},
    h('div', {class: 'look-head'}, h('span', {class: 'look-title'}, look.title), shut), body, answers(null, open));
  let gone = false;
  const away = (e: Event) => {
    if (e instanceof KeyboardEvent) { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(true); } return; }
    const at = e.target as Node;
    if (!card.contains(at) && !row.contains(at)) close(false);
  };
  const close = (back: boolean) => {
    if (gone) return;
    gone = true;
    if (out?.row === row) out = null;
    look.closing?.();
    row.setAttribute('aria-expanded', 'false');
    row.classList.remove('looked');
    document.removeEventListener('pointerdown', away, true);
    card.removeEventListener('keydown', away);
    row.removeEventListener('keydown', away);
    sizes.disconnect();
    putAway(card, () => card.remove());
    // What the row stands in may be drawn again now (a conversation read is no longer word that waits).
    row.dispatchEvent(new Event('look-closed', {bubbles: true}));
    if (back && row.isConnected) row.focus({preventScroll: true});
  };
  out = {row, close};
  shut.addEventListener('click', () => close(true));
  open.addEventListener('click', () => { close(false); look.open.go(); });
  row.setAttribute('aria-expanded', 'true');
  row.classList.add('looked');
  document.body.append(card);
  keepOut(card);
  place(card, row);
  // What it holds comes in as it is read: it keeps to the row as it grows.
  const sizes = new ResizeObserver(() => { if (!gone && row.isConnected) place(card, row); });
  sizes.observe(card);
  document.addEventListener('pointerdown', away, true);
  card.addEventListener('keydown', away);
  row.addEventListener('keydown', away);
  void Promise.resolve(look.fill(body, () => close(true))).catch((e: unknown) => body.replaceChildren(h('p', {class: 'error small'}, errorText(e))))
    .then(() => { if (!gone) (body.querySelector<HTMLElement>('textarea, input, .look-done') ?? open).focus({preventScroll: true}); });
}

/** A field to write in, with its deed at its right: Ctrl+Enter or the deed sends it; it grows with what is written. */
function writeBack(label: string, word: string, send: (text: string) => Promise<void>): HTMLElement {
  const field = h('textarea', {class: 'look-field', rows: '2', 'aria-label': label, placeholder: label, spellcheck: 'false'}) as HTMLTextAreaElement;
  const go = button(word);
  const error = h('p', {class: 'error small', role: 'alert'});
  const sent = async () => {
    const text = field.value.trim();
    if (!text || go.disabled) return;
    go.disabled = true;
    error.textContent = '';
    try { await send(text); field.value = ''; } catch (e) { error.textContent = errorText(e); } finally { go.disabled = false; field.focus(); }
  };
  go.addEventListener('click', () => void sent());
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void sent(); } });
  return h('div', {class: 'look-write'}, field, h('div', {class: 'look-write-foot'}, error, go));
}

/** One said: who (or You), when, and what. */
const said = (who: string, when: number, body: string, mine = false) =>
  h('div', {class: `look-said${mine ? ' mine' : ''}`}, h('span', {class: 'look-who'}, who, h('span', {class: 'muted small'}, ` · ${ago(when)}`)), h('p', {}, body));

/** A conversation: its last lines, read as it opens (its mark goes), and a reply sent from there. */
export function threadLook(address: string, name: string, open: () => void): Look {
  return {
    title: name || inbox.shown(address),
    open: {word: t('Open in Inbox'), go: open},
    async fill(body) {
      const lines = h('div', {class: 'look-lines'});
      const th = await inbox.thread(address);
      const each = (m: inbox.Message) => said(m.mine ? t('You') : name || inbox.shown(address), m.time,
        m.type === 'message' ? m.body : `${m.type[0].toUpperCase()}${m.type.slice(1)}：${m.body}`, m.mine);
      lines.replaceChildren(...th.messages.slice(-4).map(each));
      body.replaceChildren(lines, writeBack(t('Reply'), t('Send'), async (text) => {
        await inbox.send(address, text);
        lines.append(said(t('You'), Date.now(), text, true));
        lines.lastElementChild?.scrollIntoView({block: 'nearest'});
      }));
      void inbox.markRead(address).then(() => lookForNews(), () => {});
    },
  };
}

/** A board with posts not seen: its last ones, and a post written from there. */
export function boardLook(board: string, name: string, open: () => void): Look {
  return {
    title: `#${name}`,
    open: {word: t('Open in Server'), go: open},
    async fill(body) {
      const lines = h('div', {class: 'look-lines'});
      const read = await servers.older(board, true, null, 4);
      lines.replaceChildren(...[...read.posts].reverse().map((p) => said(p.mine ? t('You') : p.by, p.at, p.body, !!p.mine)));
      body.replaceChildren(lines, writeBack(t('Post'), t('Send'), async (text) => {
        const p = await servers.post(board, text);
        lines.append(said(t('You'), p.at, p.body, true));
      }));
    },
  };
}

/** Where one left off: the lines there, as they are now, and the way back into them. */
export function leftOffLook(repo: string, path: string, at: number | null, open: () => void): Look {
  return {
    title: path.slice(path.lastIndexOf('/') + 1),
    open: {word: t('Go on writing'), go: open},
    async fill(body) {
      const text = (await store.read(repo, path)).text ?? '';
      const end = at === null ? text.length : Math.max(0, text.indexOf('\n', at) < 0 ? text.length : text.indexOf('\n', at));
      const lines = text.slice(0, end).split('\n').slice(-4);
      body.replaceChildren(h('p', {class: 'muted small'}, t('{repo} · where you left off', {repo})), h('pre', {class: 'look-quote'}, lines.join('\n')));
    },
  };
}

/** An issue the box wrote: its summary, written right there (saved as the card goes, or is left), and the way to Git. */
export function issueLook(repo: string, file: string, open: () => void): Look {
  let issue: Issue | undefined, field: HTMLTextAreaElement | null = null;
  const save = () => {
    if (!issue || !field || field.value === issue.detail) return;
    const was = issue;
    issue = {...was, detail: field.value};
    void saveIssue(store, was, was.kind, was.title, field.value).catch(() => {});
  };
  return {
    title: issueName({n: Number(file.replace(/\.md$/, '')) || null}),
    open: {word: t('Open in Git'), go: open},
    closing: save,
    async fill(body) {
      issue = (await readIssues(store, repo)).find((i) => i.file === file);
      if (!issue) { body.replaceChildren(h('p', {class: 'muted small'}, t('No such issue'))); return; }
      field = h('textarea', {class: 'look-field', rows: '3', 'aria-label': t('Summary'), placeholder: t('Summary'), spellcheck: 'false'}) as HTMLTextAreaElement;
      field.value = issue.detail;
      field.addEventListener('blur', save);
      body.replaceChildren(h('p', {class: 'look-line'}, ...(issue.kind ? kindWords(issue.kind) : []), issue.title), field);
    },
  };
}

/** A TODO the box added: its mark, pressed done (or not) right there, and the way to Home's list. */
export function todoLook(id: string, open: () => void): Look {
  return {
    title: 'TODO',
    open: {word: t('Open in Home'), go: open},
    fill(body) {
      const draw = () => {
        const item = todo.parse(getState('todo')).find((x) => x.id === id);
        if (!item) { body.replaceChildren(h('p', {class: 'muted small'}, t('It is not in the list any more'))); return; }
        const b = h('button', {type: 'button', class: `todo-mark look-done${item.done ? ' done' : ''}`, 'aria-pressed': String(!!item.done),
          'aria-label': item.done ? t('Mark as not done') : t('Mark as done')}, todoMark(!!item.done)) as HTMLButtonElement;
        b.addEventListener('click', async () => {
          await setState('todo', JSON.stringify(todo.persisted(todo.toggle(todo.parse(getState('todo')), id))));
          draw();
          const now = body.querySelector<HTMLElement>('.look-done');
          if (now) { now.focus({preventScroll: true}); pop(now); }
        });
        body.replaceChildren(h('div', {class: `look-todo${item.done ? ' done' : ''}`}, b,
          h('span', {class: 'look-line'}, ...(item.kind ? kindWords(item.kind) : []), item.title)));
      };
      draw();
    },
  };
}
