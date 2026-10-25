import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {fileName} from './diff-view.ts';

// What was searched and read under the search box lines up sideways, in the order it came: the one in hand fills
// the large box, the ones beside it hidden past its edges but for a sliver, pressed (or ← →) to move to them.

/** What was searched and read, kept per repo, at most (how many is not decided by the issue; a short line). */
const HISTORY = 10;

/** One thing searched or read: a query, a file opened from what was found, an issue, a file's diff, a run. */
export type Seen = {what: 'query'; text: string} | {what: 'file'; path: string} | {what: 'issue'; path: string; label: string}
  | {what: 'diff'; path: string} | {what: 'run'; started: number; line: string};
export const seenKey = (s: Seen) => (s.what === 'query' ? `q:${s.text}` : s.what === 'run' ? `r:${s.started}` : `${s.what}:${s.path}`);

/** What a thing searched or read is called, and what it is. */
export const seenLabel = (s: Seen) => (s.what === 'query' ? s.text : s.what === 'issue' ? s.label : s.what === 'run' ? s.line : fileName(s.path));
export const seenKind = (s: Seen) => (s.what === 'query' ? t('Searched') : s.what === 'file' ? t('File') : s.what === 'issue' ? t('Issue') : s.what === 'diff' ? t('diff') : t('Output'));

/**
 * Per repo, while the app is open, what was searched and read, oldest first: the line it makes sideways keeps its
 * order (one come back to stays where it is), so its places hold.
 */
const history = new Map<string, Seen[]>();

/** What was searched and read in `repo`, oldest first. */
export const seenIn = (repo: string): Seen[] => history.get(repo) ?? [];

/** Something searched or read in `repo`, at the line's end (once: the same thing again stays where it is). */
export function remember(repo: string, s: Seen) {
  const list = history.get(repo) ?? [];
  if (list.some((x) => seenKey(x) === seenKey(s))) return;
  history.set(repo, [...list, s].slice(-HISTORY));
}

/** One thing searched or read, pressed to search or read it again (`again`). */
export function seenButton(s: Seen, again: (s: Seen) => void): HTMLElement {
  const b = h('button', {type: 'button', class: 'choice found-item'}, h('span', {class: 'found-kind'}, seenKind(s)),
    h('span', {class: s.what === 'run' || s.what === 'file' || s.what === 'diff' ? 'found-what mono' : 'found-what'}, seenLabel(s)));
  b.addEventListener('click', () => again(s));
  return b;
}

/** A place in the line: what kind it is, what it is called, and the way to it. */
export type Slot = {kind: string; label: string; go: () => void};

/** At the line's edge (`by` the side), the sliver of the one beside, `to`: for the pointer, as ← → are for the keyboard. */
function edge(to: Slot | undefined, by: -1 | 1): HTMLButtonElement {
  // For the pointer: the keyboard and a screen reader have the same moves in ← → under the box.
  const b = h('button', {type: 'button', class: `stage-hit ${by < 0 ? 'prev' : 'next'}`, tabindex: '-1', 'aria-hidden': 'true'}) as HTMLButtonElement;
  b.hidden = !to;
  b.addEventListener('click', () => to?.go());
  return b;
}

/** Under the box, ← or → (`by`) to the one beside, `to`: the same moves as the slivers, where a hand finds them. */
function step(to: Slot | undefined, by: -1 | 1): HTMLButtonElement {
  const b = h('button', {type: 'button', class: `found-step ${by < 0 ? 'prev' : 'next'}`, 'aria-label': to ? `${to.kind} ${to.label}`.trim() : '', title: to ? `${to.kind} ${to.label}`.trim() : ''}, by < 0 ? '←' : '→') as HTMLButtonElement;
  b.disabled = !to;
  b.addEventListener('click', () => to?.go());
  return b;
}

/** Under the box, ← and → side by side at its left, then what the one in hand is (not over what it holds). */
function nav(slots: Slot[], k: number): HTMLElement {
  const here = slots[k];
  return h('div', {class: 'found-nav'}, ...(slots.length > 1 ? [h('span', {class: 'found-steps'}, step(slots[k - 1], -1), step(slots[k + 1], 1))] : []),
    h('p', {class: 'found-here'}, h('span', {class: 'found-kind'}, here.kind), here.label ? h('span', {class: 'found-what'}, here.label) : null,
      slots.length > 1 ? h('span', {class: 'found-at'}, `${k + 1} / ${slots.length}`) : null));
}

/**
 * The line drawn in the large box (`panel`, under the box `search`), with `slots[k]` in hand holding `card`: the card
 * in hand fills it; its neighbours show a sliver past its edges, pressed to move to them, as are ← and → under the
 * box. Drawn again under the keyboard, the keyboard stays on the line.
 */
export function drawLine(search: HTMLElement, panel: HTMLElement, slots: Slot[], k: number, card: HTMLElement[]) {
  const had = panel.contains(document.activeElement) ? (document.activeElement as HTMLElement).className : '';
  const stepped = had.includes('found-step') ? (had.includes('prev') ? 'prev' : 'next') : null;
  const track = h('div', {class: 'slide-track', style: `--at:${k}`}, ...slots.map((_, i) => h('div', {class: 'slide', 'aria-current': String(i === k)},
    h('div', {class: 'found-card'}, ...(i === k ? card : [])))));
  const stage = h('div', {class: 'slide-stage', tabindex: '0', 'aria-label': t('Searched and read'), 'aria-roledescription': 'carousel'}, track, edge(slots[k - 1], -1), edge(slots[k + 1], 1));
  // Held out while the line is drawn again under the keyboard, so the keyboard can stay on it.
  const moved = had.includes('stage-hit') || had.includes('slide-stage') || !!stepped;
  if (moved) search.classList.add('moving');
  panel.replaceChildren(h('div', {class: `slides${slots.length === 1 ? ' single' : ''}${k < slots.length - 1 ? ' more' : ''}`, style: `--lead:${slots.length === 1 || k === 0 ? 0 : k === slots.length - 1 ? 2 : 1}`}, stage), nav(slots, k));
  // Moved along by a press at an edge: the keyboard stays on the line.
  if (moved) {
    // Stepped with ← or →: the keyboard stays on that step (or the line, at its end).
    const on = stepped ? panel.querySelector<HTMLButtonElement>(`.found-step.${stepped}`) : null;
    (on && !on.disabled ? on : stage).focus({preventScroll: true});
    search.classList.remove('moving');
  }
}
