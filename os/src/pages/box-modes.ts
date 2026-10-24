import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import {keepOut, paced, putAway, still} from '../glide.ts';
import {onChange, store} from '../repos.ts';
import {nextIssueName, numberOf, writeIssue} from '../issues.ts';
import * as todo from '../todo.ts';
import {getState, setState} from '../state.ts';
import {kindOf} from '../text.ts';
import {mark as todoMark} from './todo-box.ts';

// The box at the foot does one of a few things with what is written in it, and its pill, at its left, says which:
// it runs it in the repo's Prompt (the pill the prompt line the shell waits at, `garden $`), writes it as the repo's
// next issue (the pill that issue's number, `garden #4`), or puts it in Home's TODO (the pill TODO's circle). The
// pill pressed, or Alt+↓ in the box, brings the three out of it; Alt+1, 2 and 3 in the box choose one at once. Written
// for an issue or a TODO, the first line is its Kind: title as everywhere, the lines under it its detail. Sent, an
// issue is a file of the repo, which comes in among the repo's own where it is worked on: its words slide on to the
// right and rise out of sight, and the pill's number turns to the next; a TODO, seen nowhere here, goes in an arc to
// Home on the rail (glide.ts keep).

export type Mode = 'run' | 'issue' | 'todo';
export const MODES: readonly Mode[] = ['run', 'issue', 'todo'];

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
export const modeWord = (m: Mode): string => (m === 'run' ? t('Run in the Prompt') : m === 'issue' ? t('Write an issue') : t('Add to TODO'));
/** The word on the box's own button. */
export const sendWord = (m: Mode): string => (m === 'run' ? t('Run') : m === 'issue' ? t('Create') : t('Add'));
/** Its title, with the keys that do it from the box. */
export const sendTitle = (m: Mode, keys: string): string =>
  m === 'run' ? t('Run ({keys})', {keys}) : m === 'issue' ? t('Create ({keys})', {keys}) : t('Add ({keys})', {keys});
/** What the empty box says goes there. */
export const modeHint = (m: Mode, repo: string | null): string => (!repo ? t('Open a repo to run in it')
  : m === 'run' ? t('Run in {name}', {name: repo}) : m === 'issue' ? t('Write an issue in {name}', {name: repo}) : t('Add a line to TODO'));

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

/** The pill's words for a mode other than Run (Run's are the shell's prompt line, which the bench keeps). */
export function pillWords(m: Mode, repo: string | null, number: number | null): Node[] {
  if (m === 'issue') return [h('span', {class: 'prompt-mode-repo'}, repo ? `${repo} ` : ''), h('b', {}, number === null ? '#' : `#${number}`)];
  if (m === 'todo') return [todoMark(false), h('b', {}, 'TODO')];
  return [];
}

/** Where what was sent went: its place on the rail if it goes there, the words it carries, what is said of it to be heard. */
export interface Sent { to: string | null; label: Node[]; said: string }

/** Write `text` from the box as `m` (an issue of `repo`, or a TODO about it); null when there is nothing to send. */
export async function sendAs(m: Exclude<Mode, 'run'>, repo: string, text: string): Promise<Sent | null> {
  const [first = '', ...rest] = text.replace(/\s+$/, '').split('\n');
  const {kind, title} = kindOf(first);
  if (!title.trim()) return null;
  const detail = rest.join('\n').trim();
  const words = (head: string) => [h('b', {}, head), document.createTextNode(` ${title.trim()}`)];
  if (m === 'issue') {
    const file = await writeIssue(store, repo, kind, title.trim(), detail);
    const n = numberOf(file);
    if (n !== null) nextOf.set(repo, n + 1);
    const issue = `#${n ?? ''}`;
    return {to: null, label: words(issue), said: t('Written as {issue} in {name}', {issue, name: repo})};
  }
  let list = todo.add(todo.parse(getState('todo')), first, repo);
  const made = list.at(-1);
  if (made && detail) list = todo.edit(list, made.id, {detail: detail.slice(0, todo.DETAIL_LIMIT)});
  await setState('todo', JSON.stringify(todo.persisted(list)));
  return {to: 'home', label: words('TODO'), said: t('Added to TODO')};
}

/**
 * The three, out of the pill (`chip`) when it is pressed: each with the pill it gives, its word and its keys, the
 * one in use ticked. Chosen, `chosen` hears it; put away with Escape, `closed` does, with what had the keyboard.
 */
export function modeMenu(chip: HTMLElement, o: {repo: () => string | null; chosen(m: Mode): void; closed(before: Element | null): void}) {
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
      const pill = h('span', {class: 'prompt-chip box-mode-pill', 'data-mode': m, 'aria-hidden': 'true'},
        ...(m === 'run' ? [h('span', {class: 'lamp'}), h('span', {class: 'prompt-ps'}, repo ? `${repo} $` : '$')]
          : [h('span', {class: 'prompt-mode'}, ...pillWords(m, repo, typeof n === 'number' ? n : null))]));
      const item = h('button', {type: 'button', class: 'pop-item box-mode', role: 'menuitemradio', 'aria-checked': String(m === now), 'data-mode': m},
        pill, h('span', {class: 'box-mode-word'}, modeWord(m)),
        h('span', {class: 'box-mode-keys', 'aria-hidden': 'true'}, h('kbd', {}, 'Alt'), h('kbd', {}, String(i + 1)))) as HTMLButtonElement;
      item.addEventListener('click', () => { show(false); o.chosen(m); });
      return item;
    });
    pop.replaceChildren(...items);
    // Out of the pill, its rows' pills standing over it.
    const r = chip.getBoundingClientRect();
    Object.assign(pop.style, {left: `${Math.max(8, r.left - 9)}px`, bottom: `${innerHeight - r.top + 8}px`});
    show(true);
    (items.find((x) => x.getAttribute('aria-checked') === 'true') ?? items[0]).focus();
    if (n instanceof Promise) void n.then((v) => {
      const b = items[1]?.querySelector('.prompt-mode b');
      if (b) b.textContent = `#${v}`;
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

/**
 * What was written in `field`, sent where it does not go to the rail (an issue: it comes in among the repo's files):
 * its words slide on to the right, then rise out of sight, as a sheet slid off and taken. Taken as they stand now;
 * the returned call puts them over the box as it is emptied, and sends them.
 */
export function sendOff(field: HTMLTextAreaElement): () => void {
  if (still() || !field.value.trim()) return () => {};
  const r = field.getBoundingClientRect(), cs = getComputedStyle(field);
  const words = h('div', {class: 'sent-off', 'aria-hidden': 'true'}, field.value);
  Object.assign(words.style, {left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, font: cs.font,
    letterSpacing: cs.letterSpacing, padding: cs.padding, color: cs.color});
  words.scrollTop = field.scrollTop;
  return () => {
    document.body.append(words);
    words.animate([{translate: '0 0', opacity: 1, easing: 'cubic-bezier(.3, .7, .3, 1)'},
      {translate: '76px 0', opacity: 1, offset: .4, easing: 'cubic-bezier(.55, 0, .85, .35)'}, {translate: '82px -38px', opacity: 0}],
    {duration: paced(400)}).finished.then(() => words.remove(), () => words.remove());
  };
}
