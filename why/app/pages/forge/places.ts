import {h} from '../../ui/dom.ts';
import {mark} from '../../ui/icons.ts';
import {t} from '../../../text/i18n.ts';

export const WORK_PLACES = ['Prompt', 'Forge', 'Files'] as const;
export type WorkPlace = typeof WORK_PLACES[number];

export function workPlaces(owner: HTMLElement, select: (place: WorkPlace) => void, more: () => void) {
  const key = h('button', {class: 'forge-places-key', type: 'button', 'aria-label': t('Places'), 'aria-haspopup': 'menu',
    'aria-controls': 'forge-places', 'aria-expanded': 'false'}, mark('pane')) as HTMLButtonElement;
  const menu = h('div', {class: 'forge-menu forge-places', id: 'forge-places', role: 'menu', 'aria-label': t('Places'), hidden: ''});
  let here: WorkPlace = 'Forge';
  const item = (name: string, role: string, go: () => void) => {
    const b = h('button', {class: 'forge-menu-item', type: 'button', role}, t(name)) as HTMLButtonElement;
    b.addEventListener('click', () => { close(); go(); });
    menu.append(b);
    return b;
  };
  const tabs = WORK_PLACES.map((place) => item(place, 'menuitemradio', () => select(place)));
  menu.append(h('hr', {role: 'separator'}));
  const rest = item('More Places', 'menuitem', more);
  const items = () => [...tabs, rest].filter((b) => !b.disabled);
  const set = (place: WorkPlace, open: boolean) => {
    here = place;
    tabs.forEach((b, i) => { const active = WORK_PLACES[i] === place; b.setAttribute('aria-checked', `${active}`); b.disabled = !open; });
  };
  const listening = new AbortController();
  const close = (back = false) => {
    menu.hidden = true; key.setAttribute('aria-expanded', 'false');
    if (back && owner.isConnected && !owner.closest('[hidden]')) key.focus({preventScroll: true});
  };
  key.addEventListener('click', () => {
    if (!menu.hidden) { close(true); return; }
    menu.hidden = false; key.setAttribute('aria-expanded', 'true');
    const current = tabs[WORK_PLACES.indexOf(here)];
    (current && !current.disabled ? current : rest).focus({preventScroll: true});
  });
  menu.addEventListener('keydown', (e) => {
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % all.length : e.key === 'ArrowUp' ? (i + all.length - 1) % all.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : null;
    if (next !== null) { e.preventDefault(); all[next]?.focus({preventScroll: true}); }
    if (e.key === 'Tab') close();
  });
  document.addEventListener('keydown', (e) => {
    if (menu.hidden || e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault(); e.stopPropagation(); close(true);
  }, {capture: true, signal: listening.signal});
  document.addEventListener('pointerdown', (e) => {
    const target = e.target as Node;
    if (!menu.hidden && !menu.contains(target) && !key.contains(target)) close();
  }, {signal: listening.signal});
  owner.append(key, menu);
  return {key, set, close, drop: () => listening.abort()};
}
