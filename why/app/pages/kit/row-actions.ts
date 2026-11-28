import {h} from '../../ui/dom.ts';
import {mark} from '../../ui/icons.ts';
import {keepOut, putAway} from '../../ui/glide.ts';
import {t} from '../../../text/i18n.ts';

let open: (() => void) | null = null;

/** The same row key and menu, whether the row names a repo or another stored item. */
export function rowActions(name: string, fill: () => void, arrowKeys = false, pinned = false) {
  const gear = h('button', {type: 'button', class: 'repo-gear-button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    'aria-label': t('Actions for {name}', {name})}, mark(pinned ? 'gear' : 'down')) as HTMLButtonElement;
  const list = h('div', {class: 'pop repo-gear-pop', role: 'menu', 'aria-label': t('Actions for {name}', {name}), hidden: ''});

  // A Home row's key lives in a scrollport; its menu must not be clipped by it.
  const lift = pinned && typeof list.showPopover === 'function';
  if (lift) list.popover = 'manual';
  const atKey = () => {
    const key = gear.getBoundingClientRect();
    const row = gear.closest('.gear-card')?.getBoundingClientRect() ?? key;
    list.style.left = `${row.left}px`;
    list.style.top = `${key.bottom + 4}px`;
  };
  const moved = (e: Event) => {
    if (e.target instanceof Node && list.contains(e.target)) return;
    const inside = list.contains(document.activeElement);
    show(false);
    if (inside && gear.isConnected) gear.focus({preventScroll: true});
  };
  const mine = (n: Node | null) => !!n && (gear.contains(n) || list.contains(n));
  const followHand = (e: Event) => { if (!mine(e.target as Node)) show(false); };
  const away = (e: Event) => {
    if (e instanceof KeyboardEvent ? e.key !== 'Escape' : mine(e.target as Node)) return;
    const inside = mine(document.activeElement);
    show(false);
    if (e instanceof KeyboardEvent) { e.stopPropagation(); if (inside) gear.focus(); }
  };
  const show = (on: boolean) => {
    if (on) { open?.(); open = () => show(false); } else if (open) open = null;
    if (on) {
      keepOut(list);
      if (pinned) atKey();
      list.hidden = false;
      if (lift && !list.matches(':popover-open')) list.showPopover();
    } else putAway(list, () => {
      if (lift && list.matches(':popover-open')) list.hidePopover();
      list.hidden = true;
    });
    gear.setAttribute('aria-expanded', String(on));
    for (const k of ['pointerdown', 'keydown'] as const) (on ? document.addEventListener : document.removeEventListener).call(document, k, away, true);
    // Inline Runtime menus follow the hand when it goes to another item without taking an action.
    if (arrowKeys || pinned) (on ? document.addEventListener : document.removeEventListener).call(document, 'focusin', followHand, true);
    if (pinned) {
      if (on) document.addEventListener('scroll', moved, true);
      else document.removeEventListener('scroll', moved, true);
    }
    if (on) fill();
  };
  gear.addEventListener('click', (e) => { e.stopPropagation(); show(gear.getAttribute('aria-expanded') !== 'true'); });
  // Inside a card that is pressed as a whole, the gear and its list are the gear's own.
  list.addEventListener('click', (e) => e.stopPropagation());
  if (arrowKeys) list.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing) return;
    const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const items = [...list.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return; // Typing or answering in a command's own confirmation stays there.
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
      : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    e.preventDefault();
    items[next].focus();
  });
  return {gear, list, show};
}
