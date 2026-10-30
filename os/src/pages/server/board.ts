import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import * as servers from '../../remote/servers.ts';
import {boardNew, sawBoard} from '../../remote/news.ts';
import {nudge} from '../../ui/glide.ts';
import {errorText} from '../../app/errors.ts';
import {timeline} from './talk.ts';
import {boardTodo} from './todo.ts';
import {mark as todoMark} from '../todo-list.ts';
import {button, current, fitting, type Here, type Shown} from './parts.ts';

// A board's box in Server's row: in full where it is on screen, its TODO (the same list as Home's) pinned at the top,
// written there by its people, and its talk under it; beside it, only its name. The last box makes a new board.

/**
 * What is half written in a new board's name, by the server it is made in: kept while the app runs as the box's words
 * are. Put away with Escape or by going elsewhere, Server opens with it as it was; made, it is gone.
 */
const drafts = new Map<string, string>();

/** A board's box: in full where it is on screen (its TODO pinned at the top, its talk under it), only its name beside it. */
export function boardBox(b: Shown, now: boolean, signedIn: boolean): HTMLElement {
  const head = h('div', {class: 'board-head', 'data-board': b.id}, h('span', {class: 'muted board-mark', 'aria-hidden': 'true'}, '#'), h('h2', {}, b.name),
    signedIn ? null : h('span', {class: 'muted small'}, b.server), h('span', {class: 'sr-only'}));
  markBoard(head, signedIn);
  if (!now) return h('div', {class: 'board-card'}, head);
  const todo = h('section', {class: 'board-todo', 'aria-label': 'TODO'});
  const talk = h('section', {class: 'board-talk', tabindex: '0', 'aria-label': b.name});
  // Its foot in view, what came is seen: the marks go, here and on the rail.
  talk.append(timeline(talk, b.id, b.member, b.member ? (post) => sawBoard(b.id, post) : undefined));
  void boardTodo(b, todo);
  const box = h('div', {class: 'board-card'}, head, todo, talk);
  openAtFoot(box, talk);
  return box;
}

/**
 * While its talk goes on below what is shown, the box is open at its foot: the posts run past the edge, so the reader
 * sees there is more to scroll to. At the talk's foot it closes. Said by what really scrolls, nothing else; and a
 * talk that all fits (`fits`) does not say it is every post, which is plain to see.
 */
function openAtFoot(box: HTMLElement, talk: HTMLElement) {
  const more = () => {
    box.classList.toggle('more-below', talk.scrollHeight - talk.scrollTop - talk.clientHeight > 1);
    box.classList.toggle('fits', talk.scrollHeight <= talk.clientHeight + 1);
  };
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

/** What the last box needs of the view: the board once made. */
interface NewBoardWays {
  /** Made: the board stands where the box was. */
  made(id: string, board: string): void;
}

/**
 * The last box: a new board in the server chosen (in `here` as it is when Make is pressed), made where it will stand,
 * as a server is (new-server.ts): the box is the board it will be, dashed, its name written in its head in the letters
 * a board's name has, Make beside it, what a board is said quietly where its talk will be, and its TODO's first line
 * and its talk's foot faint, each where it will stand. Made, the same shapes stand there whole. Beside the one on
 * screen, only its edge and its +.
 */
export function newBoard(now: boolean, here: Here, ways: NewBoardWays): HTMLElement {
  if (!now) return h('div', {class: 'board-card board-new'}, h('div', {class: 'board-head'}, h('span', {class: 'muted board-mark'}, '+'), h('h2', {class: 'muted'}, t('New board'))));
  const name = h('input', {class: 'board-name-in', maxlength: '64', placeholder: t('What it is about'), 'aria-label': t('New board'), autocomplete: 'off'}) as HTMLInputElement;
  const kept = `${here.serverId}`;
  name.value = drafts.get(kept) ?? '';
  const make = button(t('Make'), 'small-button primary');
  // Refused (a name another board has), said under the name, where it is written.
  const error = h('p', {class: 'error small', role: 'alert'});
  const field = h('label', {class: 'board-naming'}, name);
  // As wide as the name written (or what it asks for), as a board's name is; drawn whole once it has one.
  const fit = fitting(name);
  const named = () => { fit(); field.classList.toggle('named', !!name.value.trim()); };
  queueMicrotask(named);
  const done = async () => {
    // Enter pressed again while it is made makes no second board.
    if (!here.serverId || make.disabled) return;
    const n = name.value.trim();
    if (!n) { name.focus(); nudge(field); return; }
    if (current(here)?.boards.some((b) => b.name.trim().toLowerCase() === n.toLowerCase())) {
      error.textContent = t('There is a board named {name} already', {name: n}); name.focus(); nudge(field); return;
    }
    error.textContent = '';
    make.disabled = true;
    try {
      const b = await servers.makeBoard(here.serverId, name.value);
      drafts.delete(kept);
      current(here)?.boards.push(b);
      ways.made(here.serverId, b.id);
    } catch (e) { error.textContent = errorText(e); make.disabled = false; name.focus(); nudge(field); }
  };
  make.addEventListener('click', () => void done());
  name.addEventListener('input', () => { error.textContent = ''; named(); if (name.value) drafts.set(kept, name.value); else drafts.delete(kept); });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void done(); } });
  return h('div', {class: 'board-card board-new'},
    h('div', {class: 'board-head'}, h('span', {class: 'muted board-mark', 'aria-hidden': 'true'}, '#'), field, make, error), ...ghostBody(),
    // At the top of where its talk will be (styles.css), broken where the sentence is: what a board is, then what one
    // may be about.
    h('p', {class: 'board-lead muted small'}, t('A board is one thing to talk about, with a TODO kept together:'), h('br'), t('a trip, a release, a reading group.')));
}

/**
 * What a board holds, faint, before it is made (a server's first board, or a server's next): its TODO's first line and
 * its talk's foot in their own words, each where it will stand; nothing in them to press or to be read out.
 */
export function ghostBody(): [HTMLElement, HTMLElement] {
  return [
    h('section', {class: 'board-todo board-faint', 'aria-hidden': 'true'}, h('div', {class: 'board-todo-head'}, h('span', {}, 'TODO')),
      h('div', {class: 'todo-box'}, h('div', {class: 'todo-items'}, h('div', {class: 'todo-item'}, h('div', {class: 'todo-head'},
        h('span', {class: 'todo-mark'}, todoMark(false)), h('span', {class: 'todo-kind', hidden: ''}),
        h('span', {class: 'todo-title'}, t('Something to do together'))))))),
    h('div', {class: 'board-talk board-faint', 'aria-hidden': 'true'}, h('div', {class: 'timeline tl-empty'}, h('div', {class: 'tl-start muted small'}, t('No posts yet')))),
  ];
}
