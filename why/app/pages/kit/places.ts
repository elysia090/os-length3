import {h} from '../../ui/dom.ts';
import {mark} from '../../ui/icons.ts';
import {t} from '../../../text/i18n.ts';

export const WORK_PLACES = ['Prompt', 'Forge', 'Files', 'Git'] as const;
export type WorkPlace = typeof WORK_PLACES[number];
export type ForgePlace = Exclude<WorkPlace, 'Git'>;

let made = 0;

/** One key and keyboard convention, with real routes supplied by the desk. */
export function placesMenu<K extends string>(owner: HTMLElement, places: readonly K[], start: K, select: (place: K) => void, more: () => void, action: (place: K) => boolean = () => false) {
  const id = `work-places-${++made}`;
  const key = h('button', {class: 'forge-places-key', type: 'button', 'aria-label': t('Places'), 'aria-haspopup': 'menu',
    'aria-controls': id, 'aria-expanded': 'false'}, mark('places')) as HTMLButtonElement;
  const menu = h('div', {class: 'forge-menu forge-places', id, role: 'menu', 'aria-label': t('Places'), hidden: ''});
  let here = start;
  let listening: AbortController | null = null;
  let watching: MutationObserver | null = null;
  const close = (back = false) => {
    menu.hidden = true;
    key.setAttribute('aria-expanded', 'false');
    listening?.abort(); listening = null;
    watching?.disconnect(); watching = null;
    if (back && owner.isConnected && !owner.closest('[hidden]')) key.focus({preventScroll: true});
  };
  const item = (name: string, role: string, go: () => void) => {
    const b = h('button', {class: 'forge-menu-item', type: 'button', role, tabindex: '-1', 'aria-label': t(name)}, t(name)) as HTMLButtonElement;
    b.addEventListener('click', go);
    menu.append(b);
    return b;
  };
  const tabs = places.map((place) => {
    const acts = action(place);
    return item(place, acts ? 'menuitem' : 'menuitemradio', () => {
      close(!acts && place === here);
      if (acts || place !== here) select(place);
    });
  });
  menu.append(h('hr', {role: 'separator'}));
  const rest = item('More Places', 'menuitem', () => { close(); more(); });
  const items = () => [...tabs, rest].filter((b) => !b.disabled);
  const set = (place: K, available: (destination: K) => boolean = () => true) => {
    here = place;
    tabs.forEach((b, i) => {
      const destination = places[i];
      if (!action(destination)) b.setAttribute('aria-checked', String(destination === place));
      b.disabled = !available(destination);
    });
  };
  set(start);
  key.addEventListener('click', () => {
    if (!menu.hidden) { close(true); return; }
    menu.hidden = false;
    key.setAttribute('aria-expanded', 'true');
    const current = tabs[places.indexOf(here)];
    (current && !current.disabled ? current : rest).focus({preventScroll: true});
    const {signal} = listening = new AbortController();
    document.addEventListener('pointerdown', (e) => {
      if (e.target instanceof Node && !menu.contains(e.target) && !key.contains(e.target)) close();
    }, {capture: true, signal});
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault(); e.stopPropagation(); close(true);
    }, {capture: true, signal});
    // A desk redrawn or retained and hidden does not leave an old menu listening.
    watching = new MutationObserver(() => { if (!owner.isConnected || owner.closest('[hidden]')) close(); });
    watching.observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['hidden']});
  });
  menu.addEventListener('keydown', (e) => {
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % all.length : e.key === 'ArrowUp' ? (i + all.length - 1) % all.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : null;
    if (next !== null) { e.preventDefault(); all[next]?.focus({preventScroll: true}); }
    if (e.key === 'Tab') close(true);
  });
  owner.append(key, menu);
  return {key, set, close, drop: () => close()};
}

/** Document and issue desks use the same routes. */
export function workPlaces(owner: HTMLElement, select: (place: WorkPlace) => void, more: () => void) {
  const promptIsAction = owner.classList.contains('forge-layout');
  const menu = placesMenu(owner, WORK_PLACES, 'Forge', select, more, (place) => promptIsAction && place === 'Prompt');
  return {...menu, set: (place: WorkPlace, hasRepo: boolean) => menu.set(place, (destination) => hasRepo || (destination !== 'Prompt' && destination !== 'Files'))};
}
