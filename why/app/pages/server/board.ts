import {h} from '../../ui/dom.ts';
import {t} from '../../../text/i18n.ts';
import * as servers from '../../../shipto/servers.ts';
import {connection} from '../../../shipto/connection.ts';
import {sawBoard} from '../../../shipto/news.ts';
import {nudge} from '../../ui/glide.ts';
import {errorText} from '../../../api/errors.ts';
import {seenNow, timeline} from './talk.ts';
import {boardTodo} from './todo.ts';
import {button, current, type Here, type Shown} from './parts.ts';

/** An unsubmitted thread name stays in its own room, not in the paper. */
let writingAs: string | undefined;
let names = new Map<string, string>();

/** One topic; Talk and TODO are two faces of the same paper, with a single switch above it. */
export function boardBox(b: Shown) {
  const key = `why.part.board-${b.id}`;
  const id = `topic-${b.id}`;
  const head = h('div', {class: 'board-head'},
    h('h2', {}, b.name), b.member ? null : h('p', {class: 'topic-source'}, b.server));
  const todo = h('section', {class: 'board-todo', 'aria-label': 'TODO', id: `${id}-todo`});
  const talk = h('section', {class: 'board-talk', tabindex: '0', 'aria-label': b.name, id: `${id}-talk`});
  const reading = timeline(talk, b.id, b.member, b.member ? (post) => sawBoard(b.id, post) : undefined);
  talk.append(reading.root);
  const title = h('span', {'aria-live': 'polite'});
  const next = h('button', {type: 'button', class: 'topic-face-key'}) as HTMLButtonElement;
  const over = h('div', {class: 'server-overline'}, title, next);
  const body = h('div', {class: 'board-card', 'data-board': b.id}, head, talk, todo);
  let taskTop = 0;
  const show = (that: 'talk' | 'todo') => {
    if (body.dataset.face === 'todo' && !todo.hidden) taskTop = todo.scrollTop;
    if (body.dataset.face === 'talk' && that === 'todo') reading.holdFace();
    body.dataset.face = that;
    todo.hidden = that !== 'todo';
    talk.hidden = that !== 'talk';
    if (that === 'todo') todo.scrollTop = taskTop;
    title.textContent = that === 'talk' ? t('Talk') : 'TODO';
    next.textContent = that === 'talk' ? 'TODO' : t('Talk');
    next.setAttribute('aria-controls', that === 'talk' ? todo.id : talk.id);
    try { localStorage.setItem(key, that); } catch { /* convenience only */ }
    if (that === 'talk') { reading.showFace(); requestAnimationFrame(seenNow); }
  };
  let last: string | null = null;
  try { last = localStorage.getItem(key); } catch { /* convenience only */ }
  show(last === 'todo' ? 'todo' : 'talk');
  next.addEventListener('click', () => show(body.dataset.face === 'talk' ? 'todo' : 'talk'));
  void boardTodo(b, todo, () => { show('talk'); next.hidden = true; });
  return {body, over, drop: reading.stop};
}

/** What the last box needs of the view: the board once made. */
interface NewBoardWays {
  /** Made: the board stands where the box was. */
  made(id: string, board: string): void;
}

/** A real thread is created in this room; an answer can never change the room in hand. */
export function newBoard(here: Here, ways: NewBoardWays): HTMLElement {
  const room = current(here);
  const session = connection()?.session;
  if (writingAs !== session) { writingAs = session; names = new Map(); }
  const drafts = names;
  const kept = room?.id ?? '';
  const name = h('input', {class: 'board-name-in', maxlength: '64', placeholder: t('Thread name'), 'aria-label': t('Thread name'), autocomplete: 'off'}) as HTMLInputElement;
  name.value = drafts.get(kept) ?? '';
  const make = button(t('Create'), 'topic-face-key');
  const error = h('p', {class: 'error small', role: 'alert'});
  const done = async () => {
    if (!room || here.serverId !== kept || make.disabled) return;
    const n = name.value.trim();
    if (!n) { name.focus(); return; }
    if (room.boards.some((b) => b.name.trim().toLowerCase() === n.toLowerCase())) {
      error.textContent = t('A board named "{name}" already exists', {name: n}); name.focus(); return;
    }
    error.textContent = '';
    make.disabled = true;
    name.readOnly = true;
    try {
      const b = await servers.makeBoard(kept, n);
      drafts.delete(kept);
      const still = here.list.find((s) => s.id === kept);
      if (still && !still.boards.some((x) => x.id === b.id)) still.boards.push(b);
      ways.made(kept, b.id);
    } catch (e) {
      error.textContent = errorText(e); make.disabled = false; name.readOnly = false;
      if (name.isConnected) { name.focus(); nudge(name); }
    }
  };
  make.addEventListener('click', () => void done());
  name.addEventListener('input', () => { error.textContent = ''; if (name.value) drafts.set(kept, name.value); else drafts.delete(kept); });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void done(); } });
  return h('div', {class: 'board-card board-new'},
    h('div', {class: 'board-head'}, h('h2', {}, t('New thread'))),
    h('div', {class: 'board-create'}, name,
      room ? h('p', {class: 'muted'}, t('Only {server} members can read it.', {server: room.name})) : null, error),
    h('div', {class: 'board-create-foot'}, make));
}

/**
 * What a board holds, faint, before it is made (a server's first board, or a server's next): its talk's foot in its
 * own words, where it will stand, the part a board opens at; nothing in it to press or to be read out.
 */
export function ghostBody(): HTMLElement {
  return h('div', {class: 'board-talk board-faint', 'aria-hidden': 'true'}, h('div', {class: 'timeline tl-empty'}, h('div', {class: 'tl-start muted small'}, t('No posts yet'))));
}
