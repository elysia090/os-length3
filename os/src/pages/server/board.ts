import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import * as servers from '../../remote/servers.ts';
import {boardNew, sawBoard} from '../../remote/news.ts';
import {nudge} from '../../ui/glide.ts';
import {errorText} from '../../app/errors.ts';
import {timeline} from './talk.ts';
import {boardTodo} from './todo.ts';
import {button, current, type Here, type Shown, type Writer} from './parts.ts';

// A board's box in Server's row: in full where it is on screen, its TODO (the same list as Home's) pinned at the top,
// written there by its people, and its talk under it; beside it, only its name. The last box makes a new board.

/**
 * What is half written in a new board's name, by the server it is made in: kept while the app runs as the box's words
 * are. Put away with Escape or by going elsewhere, Server opens with it as it was; made, it is gone.
 */
const drafts = new Map<string, string>();

/** A board's box: in full where it is on screen (its TODO pinned at the top, its talk under it), only its name beside it. */
export function boardBox(b: Shown, now: boolean, signedIn: boolean, writer: Writer): HTMLElement {
  const head = h('div', {class: 'board-head', 'data-board': b.id}, h('span', {class: 'muted board-mark', 'aria-hidden': 'true'}, '#'), h('h2', {}, b.name),
    signedIn ? null : h('span', {class: 'muted small'}, b.server), h('span', {class: 'sr-only'}));
  markBoard(head, signedIn);
  if (!now) return h('div', {class: 'board-card'}, head);
  const todo = h('section', {class: 'board-todo', 'aria-label': 'TODO'});
  const talk = h('section', {class: 'board-talk', tabindex: '0', 'aria-label': b.name});
  // Its foot in view, what came is seen: the marks go, here and on the rail.
  talk.append(timeline(talk, b.id, b.member, b.member ? (post) => sawBoard(b.id, post) : undefined));
  void boardTodo(b, todo, (busy) => writer(todo, busy));
  const box = h('div', {class: 'board-card'}, head, todo, talk);
  openAtFoot(box, talk);
  return box;
}

/**
 * While its talk goes on below what is shown, the box is open at its foot: the posts run past the edge, so the reader
 * sees there is more to scroll to. At the talk's foot it closes. Said by what really scrolls, nothing else.
 */
function openAtFoot(box: HTMLElement, talk: HTMLElement) {
  const more = () => box.classList.toggle('more-below', talk.scrollHeight - talk.scrollTop - talk.clientHeight > 1);
  talk.addEventListener('scroll', more, {passive: true});
  const grown = new ResizeObserver(more);
  grown.observe(talk);
  for (const el of talk.children) grown.observe(el);
}

/** A board's #: a dot while something came in it not seen yet, and said so to a screen reader. */
export function markBoard(head: HTMLElement, signedIn: boolean) {
  const id = head.dataset.board ?? '', on = signedIn && boardNew(id);
  head.classList.toggle('news', on);
  const said = head.querySelector('.sr-only');
  if (said) said.textContent = on ? t('New posts') : '';
}

/** What the last box needs of the view: where something is written, and showing the board once made. */
interface NewBoardWays {
  writer: Writer;
  show(id: string, board: string): void;
}

/** The last box: a new board in the server chosen (in `here` as it is when Make is pressed). */
export function newBoard(now: boolean, here: Here, ways: NewBoardWays): HTMLElement {
  if (!now) return h('div', {class: 'board-card board-new'}, h('div', {class: 'board-head'}, h('span', {class: 'muted'}, '+'), h('h2', {class: 'muted'}, t('New board'))));
  const name = h('input', {class: 'line-in', maxlength: '64', placeholder: t('What it is about'), 'aria-label': t('New board')}) as HTMLInputElement;
  const kept = `${here.serverId}`;
  name.value = drafts.get(kept) ?? '';
  const make = button(t('Make'), 'primary');
  const error = h('p', {class: 'error', role: 'alert'});
  ways.writer(name, () => document.activeElement === name || !!name.value.trim());
  const done = async () => {
    // Enter pressed again while it is made makes no second board.
    if (!here.serverId || make.disabled) return;
    const n = name.value.trim();
    if (!n) { name.focus(); nudge(name); return; }
    if (current(here)?.boards.some((b) => b.name.trim().toLowerCase() === n.toLowerCase())) {
      error.textContent = t('There is a board named {name} already', {name: n}); name.focus(); nudge(name); return;
    }
    error.textContent = '';
    make.disabled = true;
    try {
      const b = await servers.makeBoard(here.serverId, name.value);
      drafts.delete(kept);
      current(here)?.boards.push(b);
      ways.show(here.serverId, b.id);
    } catch (e) { error.textContent = errorText(e); make.disabled = false; name.focus(); nudge(name); }
  };
  make.addEventListener('click', () => void done());
  name.addEventListener('input', () => { error.textContent = ''; if (name.value) drafts.set(kept, name.value); else drafts.delete(kept); });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void done(); } });
  return h('div', {class: 'board-card board-new'},
    h('div', {class: 'board-head'}, h('span', {class: 'muted'}, '+'), h('h2', {}, t('New board'))),
    // Broken where the sentence is: what a board is, then what one may be about.
    h('div', {class: 'board-body'}, h('p', {class: 'muted'}, t('A board is one thing to talk about, with a TODO kept together:'), h('br'), t('a trip, a release, a reading group.')),
      h('div', {class: 'row'}, name, make), error));
}
