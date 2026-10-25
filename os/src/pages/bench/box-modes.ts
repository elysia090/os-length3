import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {keepOut, paced, putAway, still} from '../../ui/glide.ts';
import {onChange, store} from '../../repos/repos.ts';
import {nextIssueName, numberOf, writeIssue} from '../../repos/issues.ts';
import * as todo from '../../home/todo.ts';
import {getState, setState} from '../../home/state.ts';
import {kindOf} from '../../repos/text.ts';
import {mark} from '../../ui/icons.ts';
import {mark as todoMark} from '../todo-list.ts';

// The box at the foot does one of a few things with what is written in it, and its pill, at its left, says which:
// it runs it in the repo's Prompt (the pill the prompt line the shell waits at, `garden $`), writes it as the repo's
// next issue (the pill that issue's number, `garden #4`), puts it in Home's TODO (the pill TODO's circle), or edits
// the file in front with it (the pill a pencil, the file and the caret's line, `README.md :12`; edit-box.ts). The pill
// pressed, or Alt+↓ in the box, brings the four out of it; Alt+1 to 4 in the box choose one at once. Written for an
// issue or a TODO, the first line is its Kind: title as everywhere, the lines under it its detail. Sent, an issue is a
// file of the repo, which comes in among the repo's own where it is worked on: its words slide on to the right and
// rise out of sight, and the pill's number turns to the next; a TODO, seen nowhere here, goes in an arc to Home on the
// rail (glide.ts keep).

export type Mode = 'run' | 'issue' | 'todo' | 'edit';
export const MODES: readonly Mode[] = ['run', 'issue', 'todo', 'edit'];

/** What the boxes do, the same on every page's box for as long as the app runs. */
let now: Mode = 'run';
const heard = new Set<(m: Mode) => void>();
export const boxMode = (): Mode => now;
export function setBoxMode(m: Mode) {
  if (m === now) return;
  now = m;
  for (const f of [...heard]) f(m);
}
/** Hear the boxes' mode change (chosen in another page's box too); returns how to stop. */
export function onBoxMode(f: (m: Mode) => void): () => void { heard.add(f); return () => heard.delete(f); }

/** What each is called where it is chosen. */
const modeWord = (m: Mode): string =>
  (m === 'run' ? t('Run in the Prompt') : m === 'issue' ? t('Write an issue') : m === 'todo' ? t('Add to TODO') : t('Edit the file in front'));
/** The word on the box's own button. */
export const sendWord = (m: Mode): string => (m === 'run' ? t('Run') : m === 'issue' ? t('Create') : m === 'todo' ? t('Add') : t('Apply'));
/** Its title, with the keys that do it from the box (Edit's is Enter alone: what it is written in is one line). */
export const sendTitle = (m: Mode, keys: string): string =>
  m === 'run' ? t('Run ({keys})', {keys}) : m === 'issue' ? t('Create ({keys})', {keys}) : m === 'todo' ? t('Add ({keys})', {keys}) : t('Apply (Enter)');
/** What the empty box says goes there (for Edit, with the file in front, `file`, the lines it takes). */
export const modeHint = (m: Mode, repo: string | null, file: string | null = null): string => (!repo ? t('Open a repo to run in it')
  : m === 'run' ? t('Run in {name}', {name: repo}) : m === 'issue' ? t('Write an issue in {name}', {name: repo}) : m === 'todo' ? t('Add a line to TODO')
  : file ? t('{file}: a line number, a word, old → new, + a line', {file}) : t('Open a file to edit it here'));

/** The number the repo's next issue takes, read as its issues change (null until read). */
const nextOf = new Map<string, number | Promise<number>>();
onChange((c) => { if (c.repo) nextOf.delete(c.repo); });
export function nextIssue(repo: string): number | Promise<number> {
  let n = nextOf.get(repo);
  if (n === undefined) {
    const p = store.tree(repo, 'issue').then((es) => es.filter((e) => e.kind === 'file').map((e) => e.name), () => [] as string[])
      .then((names) => numberOf(nextIssueName(names)) ?? 1);
    nextOf.set(repo, p);
    void p.then((v) => { if (nextOf.get(repo) === p) nextOf.set(repo, v); });
    n = p;
  }
  return n;
}

/**
 * The pill's words for a mode other than Run (Run's are the shell's prompt line, which the bench keeps): the issue's
 * number; TODO; for Edit the file in front and the caret's line (`at`).
 */
export function pillWords(m: Mode, repo: string | null, number: number | null, at: {file: string; line: number} | null = null): Node[] {
  if (m === 'issue') return [h('span', {class: 'prompt-mode-repo'}, repo ? `${repo} ` : ''), h('b', {}, number === null ? '#' : `#${number}`)];
  if (m === 'todo') return [todoMark(false), h('b', {}, 'TODO')];
  if (m === 'edit') return [mark('pen'), h('b', {}, at?.file ?? t('Edit')), ...(at ? [h('span', {class: 'prompt-mode-line'}, `:${at.line}`)] : [])];
  return [];
}

/**
 * What was sent: its head and words as its line in the Prompt's flow says them (#3 and its title; TODO and its
 * words), what it is to go back to it (the issue's file, or Home's TODO), and what is said of it to be heard.
 */
interface Sent { head: string; words: string; to: {issue: string} | {todo: string}; said: string }

/** Write `text` from the box as `m` (an issue of `repo`, or a TODO about it); null when there is nothing to send. */
export async function sendAs(m: 'issue' | 'todo', repo: string, text: string): Promise<Sent | null> {
  const [first = '', ...rest] = text.replace(/\s+$/, '').split('\n');
  const {kind, title} = kindOf(first);
  if (!title.trim()) return null;
  const detail = rest.join('\n').trim();
  if (m === 'issue') {
    const file = await writeIssue(store, repo, kind, title.trim(), detail);
    const n = numberOf(file);
    if (n !== null) nextOf.set(repo, n + 1);
    const issue = `#${n ?? ''}`;
    return {head: issue, words: kind ? `${kind}：${title.trim()}` : title.trim(), to: {issue: file}, said: t('Written as {issue} in {name}', {issue, name: repo})};
  }
  let list = todo.add(todo.parse(getState('todo')), first, repo);
  const made = list.at(-1);
  if (made && detail) list = todo.edit(list, made.id, {detail: detail.slice(0, todo.DETAIL_LIMIT)});
  await setState('todo', JSON.stringify(todo.persisted(list)));
  return {head: 'TODO', words: first.trim(), to: {todo: made?.id ?? ''}, said: t('Added to TODO')};
}

/**
 * `m`, the `i`th of the four, as a row of the menu out of the pill: the pill it gives (for `repo`, its next issue's
 * number `n`, the file in front and its line `at`), its word and its keys; ticked when it is the one in use.
 */
function menuItem(m: Mode, i: number, repo: string | null, n: number | null,
  at: {file: string; line: number} | null): HTMLButtonElement {
  const pill = h('span', {class: 'prompt-chip box-mode-pill', 'data-mode': m, 'aria-hidden': 'true'},
    ...(m === 'run' ? [h('span', {class: 'lamp'}), h('span', {class: 'prompt-ps'}, repo ? `${repo} $` : '$')]
      : [h('span', {class: 'prompt-mode'}, ...pillWords(m, repo, n, at))]));
  return h('button', {type: 'button', class: 'pop-item box-mode', role: 'menuitemradio', 'aria-checked': String(m === now), 'data-mode': m},
    pill, h('span', {class: 'box-mode-word'}, modeWord(m)),
    h('span', {class: 'box-mode-keys', 'aria-hidden': 'true'}, h('kbd', {}, 'Alt'), h('kbd', {}, String(i + 1)))) as HTMLButtonElement;
}

/** Each pill as wide as its words, the words after them in one column: the room a narrower pill leaves is kept after it. */
function column(items: HTMLElement[]) {
  const pills = items.map((i) => i.querySelector<HTMLElement>('.box-mode-pill')!);
  for (const p of pills) p.style.marginRight = '';
  const widest = Math.max(...pills.map((p) => p.offsetWidth));
  for (const p of pills) p.style.marginRight = `${widest - p.offsetWidth}px`;
}

/**
 * The four, out of the pill (`chip`) when it is pressed: each with the pill it gives, its word and its keys, the
 * one in use ticked. Chosen, `chosen` hears it; put away with Escape, `closed` does, with what had the keyboard.
 */
export function modeMenu(chip: HTMLElement, o: {repo: () => string | null; at(): {file: string; line: number} | null; chosen(m: Mode): void;
  closed(before: Element | null): void}) {
  const pop = h('div', {class: 'pop box-modes', role: 'menu', 'aria-label': t('What the box does'), hidden: ''});
  let items: HTMLButtonElement[] = [];
  /** What had the keyboard before they came out: Escape gives it back (a press elsewhere, or Tab, takes it on). */
  let before: Element | null = null;
  const away = (e: Event) => {
    if (e instanceof KeyboardEvent ? e.key !== 'Escape' && e.key !== 'Tab' : pop.contains(e.target as Node) || chip.contains(e.target as Node)) return;
    show(false);
    if (e instanceof KeyboardEvent && e.key === 'Escape') { e.preventDefault(); o.closed(before); }
  };
  const show = (on: boolean) => {
    if (on) { keepOut(pop); pop.hidden = false; } else putAway(pop, () => { pop.hidden = true; });
    chip.setAttribute('aria-expanded', String(on));
    for (const k of ['pointerdown', 'keydown'] as const) (on ? document.addEventListener : document.removeEventListener).call(document, k, away, true);
  };
  pop.addEventListener('keydown', (e) => {
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    items[(at + step + items.length) % items.length]?.focus();
  });
  const open = () => {
    before = document.activeElement;
    const repo = o.repo();
    const n = repo ? nextIssue(repo) : null;
    items = MODES.map((m, i) => {
      const item = menuItem(m, i, repo, typeof n === 'number' ? n : null, m === 'edit' ? o.at() : null);
      item.addEventListener('click', () => { show(false); o.chosen(m); });
      return item;
    });
    pop.replaceChildren(...items);
    // Out of the pill, its rows' pills standing over it.
    const r = chip.getBoundingClientRect();
    Object.assign(pop.style, {left: `${Math.max(8, r.left - 9)}px`, bottom: `${innerHeight - r.top + 8}px`});
    show(true);
    column(items);
    (items.find((x) => x.getAttribute('aria-checked') === 'true') ?? items[0]).focus();
    if (n instanceof Promise) void n.then((v) => {
      const b = items[1]?.querySelector('.prompt-mode b');
      if (b) b.textContent = `#${v}`;
      column(items);
    });
  };
  return {element: pop, open, shown: () => !pop.hidden, close: () => show(false)};
}

/**
 * The pill turning from one mode to the next: its width from the old words' to the new, the old words going up out
 * of it as the new come up into it, its colours crossing (styles.css), and a small beat as it lands; the box's own
 * button's word comes in as the pill's does. `change` puts the new mode's words in.
 */
export function turn(chip: HTMLElement, button: HTMLElement, change: () => void) {
  if (still()) { change(); return; }
  const was = chip.getBoundingClientRect().width;
  const cs = getComputedStyle(chip);
  const ghost = h('span', {class: 'prompt-ghost', 'aria-hidden': 'true'});
  ghost.style.padding = cs.padding;
  ghost.style.color = cs.color;
  for (const c of chip.children) if (getComputedStyle(c).display !== 'none') ghost.append(c.cloneNode(true));
  change();
  const width = chip.getBoundingClientRect().width;
  chip.append(ghost);
  chip.style.overflow = 'hidden';
  const ms = paced(240);
  const done = () => { ghost.remove(); chip.style.overflow = ''; };
  chip.animate([{width: `${was}px`}, {width: `${width}px`}], {duration: ms, easing: 'cubic-bezier(.2, .9, .25, 1)'}).finished.then(done, done);
  // The old words are out (up) before the new are in (from below), as a counter's figures turn, never one over the other.
  ghost.animate([{translate: '0 0', opacity: 1}, {translate: '0 -12px', opacity: 0}], {duration: ms * .4, easing: 'ease-in', fill: 'forwards'});
  for (const c of chip.children) {
    if (c === ghost || getComputedStyle(c).display === 'none') continue;
    c.animate([{translate: '0 12px', opacity: 0}, {translate: '0 12px', opacity: 0, offset: .38}, {translate: '0 0', opacity: 1}],
      {duration: ms * 1.15, easing: 'cubic-bezier(.2, .9, .25, 1)'});
  }
  chip.animate([{scale: '1 1'}, {scale: '.96 .9', offset: .3}, {scale: '1.03 1.04', offset: .65}, {scale: '1 1'}], {duration: paced(300), easing: 'ease-out'});
  button.animate([{opacity: 0, translate: '0 5px'}, {opacity: 1, translate: '0 0'}], {duration: ms, easing: 'cubic-bezier(.2, .9, .25, 1)'});
}

/** A line just come into the Prompt's flow, lit a moment as it lands (as a file landed on is: styles.css landed). */
const lit = (row: HTMLElement) => row.animate([{backgroundColor: 'color-mix(in srgb, var(--marker) 70%, transparent)'},
  {backgroundColor: 'color-mix(in srgb, var(--marker) 70%, transparent)', offset: .3}, {backgroundColor: 'transparent'}], {duration: paced(1200), easing: 'ease-out'});
/** The slip's margin round its words (styles.css .slip's padding). */
const SLIP = {x: 6, y: 2};
/** Whether `row` is where it can be seen: on the screen, inside the Prompt's output where it scrolls. */
const seen = (row: HTMLElement) => {
  const r = row.getBoundingClientRect(), out = row.closest('.term-out')?.getBoundingClientRect();
  return r.width > 0 && !row.closest('[hidden], [inert]') && !!out && r.top >= out.top - 1 && r.bottom <= out.bottom + 1
    && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
};

/**
 * What was written in `field` (an issue, a TODO), taken as it stands now; the returned call, as the box is emptied,
 * sends it to `row`, its line in the right pane's Prompt, there by then: its first line slides on to the right, as a
 * sheet slid off, and on into that line, coming down to its size; the line takes it as it arrives, and is lit a
 * moment. With the line not where it can be seen (the pane put away, a narrow window), the words slide on and rise
 * out of sight, as a sheet slid off and taken; the line is there when the pane is brought back.
 */
export function sendInto(field: HTMLTextAreaElement): (row: HTMLElement | null) => void {
  if (still() || !field.value.trim()) return () => {};
  const r = field.getBoundingClientRect(), cs = getComputedStyle(field);
  // Where its words start in the box: the slip is laid so its words are where they were.
  const from = {x: r.left + (parseFloat(cs.paddingLeft) || 0), y: r.top + (parseFloat(cs.paddingTop) || 0) - field.scrollTop};
  const words = h('div', {class: 'sent-off slip', 'aria-hidden': 'true'}, field.value.split('\n')[0]);
  Object.assign(words.style, {left: `${from.x - SLIP.x}px`, top: `${from.y - SLIP.y}px`, maxWidth: `${r.right - from.x}px`,
    font: cs.font, letterSpacing: cs.letterSpacing, color: cs.color, transformOrigin: `${SLIP.x}px ${SLIP.y}px`});
  return (row) => {
    document.body.append(words);
    if (!row || !seen(row)) slideAway(words);
    else slideInto(words, row, from, parseFloat(cs.fontSize) || 1);
  };
}

/** The slip `words` slid on to the right and rising out of sight, as a sheet slid off and taken. */
function slideAway(words: HTMLElement) {
  const gone = () => words.remove();
  words.animate([{translate: '0 0', opacity: 1, easing: 'cubic-bezier(.3, .7, .3, 1)'},
    {translate: '76px 0', opacity: 1, offset: .4, easing: 'cubic-bezier(.55, 0, .85, .35)'}, {translate: '82px -38px', opacity: 0}],
  {duration: paced(400)}).finished.then(gone, gone);
}

/**
 * The slip `words` (its words starting at `from`, `size` px) slid on to the right and on into `row`, coming down to
 * its size; the line takes it as it arrives, and is lit a moment.
 */
function slideInto(words: HTMLElement, row: HTMLElement, from: {x: number; y: number}, size: number) {
  const gone = () => words.remove();
  // To where its words stand in the line (after its head, #3 or TODO), at the line's size.
  const range = document.createRange();
  range.selectNodeContents(row.lastChild ?? row);
  const to = range.getBoundingClientRect(), scale = parseFloat(getComputedStyle(row).fontSize) / size;
  const dx = to.left - from.x, dy = to.top - from.y;
  const ms = paced(560);
  const paper = 'var(--paper)', bare = 'color-mix(in srgb, var(--paper) 0%, transparent)';
  const lift = '0 6px 18px color-mix(in srgb, var(--ink) 12%, transparent)', flat = '0 0 0 transparent';
  words.animate([
    {translate: '0 0', scale: '1', backgroundColor: bare, boxShadow: flat, easing: 'cubic-bezier(.3, .7, .3, 1)'},
    {translate: '28px 0', scale: '1', backgroundColor: paper, boxShadow: lift, offset: .22, easing: 'cubic-bezier(.45, 0, .2, 1)'},
    {translate: `${dx}px ${dy}px`, scale: `${scale}`, backgroundColor: bare, boxShadow: flat, opacity: 1, offset: .9},
    {translate: `${dx}px ${dy}px`, scale: `${scale}`, backgroundColor: bare, boxShadow: flat, opacity: 0}],
  {duration: ms}).finished.then(gone, gone);
  row.animate([{opacity: 0}, {opacity: 0, offset: .86}, {opacity: 1}], {duration: ms}).finished.then(() => { if (row.isConnected) lit(row); }, () => {});
}
