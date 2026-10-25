import {h} from '../../ui/dom.ts';
import {errorText} from '../../app/errors.ts';
import {t} from '../../i18n.ts';
import {every} from '../../app/runs.ts';
import * as servers from '../../remote/servers.ts';
import type {Shown} from './parts.ts';
import {sayLeft, todoList} from '../todo-list.ts';

/** How often a board's TODO is looked at again, while the page is in view. */
const EVERY = 15_000;

/**
 * A board's TODO, pinned at the top of its box in `holder`: Home's list, kept
 * together on the Remote (shown, not written, outside the server; not shown
 * at all there while it is empty). What others change is taken in every
 * little while, whenever nothing written here is waiting. `writing` hears how
 * to tell whether something is being written in it (the layer stays out while
 * it is).
 */
export async function boardTodo(b: Shown, holder: HTMLElement, writing: (busy: () => boolean) => void): Promise<void> {
  const left = h('small', {class: 'muted'});
  const status = h('p', {class: 'error small', role: 'alert'});
  let list: servers.BoardTodo[];
  try { list = await servers.todos(b.id, b.member); } catch (e) { holder.replaceChildren(h('p', {class: 'error'}, errorText(e))); return; }
  if (!b.member && !list.length) { holder.remove(); return; }
  // Not sent (the Remote away): said under the list, and sent again by itself.
  const keeper = b.member ? servers.todoKeeper(b.id, list, {trouble: (why) => { status.textContent = t('Could not save: {message}', {message: why}); }}) : null;
  const box = todoList(list, keeper ? (kept) => keeper.save(kept) : async () => {},
    {readOnly: !b.member, first: t('Something to do together'), counted: (x) => sayLeft(left, x), failed: (why) => { status.textContent = why; }});
  writing(() => holder.contains(document.activeElement) || (keeper ? !keeper.idle() : false));
  holder.replaceChildren(h('div', {class: 'board-todo-head'}, h('span', {}, 'TODO'), left), box.element, status);
  let seen = JSON.stringify(list);
  // Until the box is gone; one not answered is the next one's to bring.
  every(EVERY, async () => {
    if (keeper && !keeper.idle()) return;
    const now = await servers.todos(b.id, b.member).catch(() => null);
    if (!now || (keeper && !keeper.idle()) || JSON.stringify(now) === seen) return;
    seen = JSON.stringify(now);
    keeper?.took(now);
    box.update(now);
  }, {alive: () => holder.isConnected, paced: true});
}
