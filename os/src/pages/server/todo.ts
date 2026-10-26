import {h} from '../../ui/dom.ts';
import {errorText} from '../../app/errors.ts';
import {t} from '../../i18n.ts';
import {every} from '../../app/runs.ts';
import {paced, still} from '../../ui/glide.ts';
import * as servers from '../../remote/servers.ts';
import type {Shown} from './parts.ts';
import {todoList} from '../todo-list.ts';

/** How often a board's TODO is looked at again, while the page is in view. */
const EVERY = 15_000;

/**
 * A board's TODO, one of its two parts, in `holder`: Home's list, kept
 * together on the Remote (shown, not written, outside the server; not there
 * at all while it is empty: `told.none`). How many are left is told as it
 * changes (`told.left`), to be said on its part. What others change is taken
 * in every little while, whenever nothing written here is waiting.
 */
export async function boardTodo(b: Shown, holder: HTMLElement, told: {left(open: number): void; none(): void}): Promise<void> {
  const status = h('p', {class: 'error small', role: 'alert'});
  let list: servers.BoardTodo[];
  try { list = await servers.todos(b.id, b.member); } catch (e) { holder.replaceChildren(h('p', {class: 'error'}, errorText(e))); return; }
  if (!b.member && !list.length) { told.none(); return; }
  // Not sent (the Remote away): said under the list, and sent again by itself.
  const keeper = b.member ? servers.todoKeeper(b.id, list, {trouble: (why) => { status.textContent = t('Could not save: {message}', {message: why}); }}) : null;
  const box = todoList(list, keeper ? (kept) => keeper.save(kept) : async () => {},
    {readOnly: !b.member, first: t('Something to do together'), counted: (open) => told.left(open), failed: (why) => { status.textContent = why; }});
  // How many are left is said on its part; Clear done, while some are, under the list.
  holder.replaceChildren(box.element, box.clear, status);
  // Read in after its board was drawn: it comes up where it stands, as the talk does.
  if (!still()) holder.animate([{opacity: 0}, {opacity: 1}], {duration: paced(200), easing: 'ease-out'});
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
