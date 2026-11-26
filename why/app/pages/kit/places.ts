import {h} from '../../ui/dom.ts';
import {mark} from '../../ui/icons.ts';
import {activateOnPress} from '../../ui/press.ts';
import {t} from '../../../text/i18n.ts';

export const WORK_PLACES = ['Prompt', 'Forge', 'Files', 'Git'] as const;
export type WorkPlace = typeof WORK_PLACES[number];
export type ForgePlace = Exclude<WorkPlace, 'Git'>;
export interface PlaceCommand {
  label: string;
  run(anchor: HTMLElement): void;
  /** Existing shell destinations go on a mouse press, but not on the start of a touch scroll. */
  onPress?: boolean;
}

type Find = (origin: Element | null) => void;

export interface SearchDesk {
  /** The repo in the hand, if any; an empty search can still look for an actual local scope. */
  readonly repo: string | null;
  searchRepo?(repo: string | null, origin?: Element | null, rejoin?: () => HTMLElement | null): void;
}
interface PlaceKeys<K> {
  action?(place: K): boolean;
  find?: Find;
}

let made = 0;

/** Route the corner key to the same Search, using the repo of the desk in hand, if any. */
export function deskSearch(ctx: SearchDesk, repo: () => string | null = () => ctx.repo): Find {
  return (origin) => ctx.searchRepo?.(repo(), origin, () => document.querySelector<HTMLElement>('#page .forge-search-key'));
}

/** One set of corner keys and keyboard conventions. This desk supplies the routes. */
export function placesMenu<K extends string>(owner: HTMLElement, places: readonly K[], start: K, select: (place: K) => void,
  extra: () => readonly PlaceCommand[], {action = () => false, find}: PlaceKeys<K> = {}) {
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
  const item = (name: string, role: string, go: () => void, onPress = false) => {
    const b = h('button', {class: 'forge-menu-item', type: 'button', role, tabindex: '-1', 'aria-label': t(name)}, t(name)) as HTMLButtonElement;
    if (onPress) activateOnPress(b, go);
    else b.addEventListener('click', go);
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
  let commands: HTMLButtonElement[] = [];
  const items = () => [...tabs, ...commands].filter((b) => !b.disabled);
  const focus = (b: HTMLButtonElement | undefined, edge?: 'Home' | 'End') => {
    if (!b) return;
    b.focus({preventScroll: true});
    // Take endpoints exactly even if a preceding wheel tick brought a fractional row into view.
    if (edge) { menu.scrollTop = edge === 'Home' ? 0 : menu.scrollHeight; return; }
    const row = b.getBoundingClientRect(), bounds = menu.getBoundingClientRect();
    const top = bounds.top + menu.clientTop, bottom = top + menu.clientHeight;
    if (row.top < top) menu.scrollTop += Math.floor(row.top - top);
    else if (row.bottom > bottom) menu.scrollTop += Math.ceil(row.bottom - bottom);
  };
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
    commands.forEach((button) => button.remove());
    commands = extra().map(({label, run, onPress}) => item(label, 'menuitem', () => { close(); run(key); }, onPress));
    menu.hidden = false;
    key.setAttribute('aria-expanded', 'true');
    menu.dataset.keys = '';
    menu.scrollTop = 0;
    const current = tabs[places.indexOf(here)];
    focus(current && !current.disabled ? current : items()[0]);
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
  const pointerScroll = () => { delete menu.dataset.keys; };
  menu.addEventListener('wheel', pointerScroll, {passive: true});
  menu.addEventListener('pointerdown', pointerScroll, {passive: true});
  menu.addEventListener('keydown', (e) => {
    const all = items();
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? (i + 1) % all.length : e.key === 'ArrowUp' ? (i + all.length - 1) % all.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : null;
    if (next !== null) {
      e.preventDefault();
      // End a wheel's snap animation before laying out what the keyboard picked.
      menu.dataset.keys = '';
      focus(all[next], e.key === 'Home' || e.key === 'End' ? e.key : undefined);
    }
    if (e.key === 'Tab') close(true);
  });
  if (find) {
    const search = h('button', {class: 'forge-search-key', type: 'button', 'aria-label': t('Search')}, mark('search'));
    // The mouse usually takes focus from the paper before click. Return to that paper, not to the key by mistake.
    let pressed: Element | null = null;
    search.addEventListener('pointerdown', (event) => { if (event.isPrimary && event.button === 0) pressed = document.activeElement; });
    search.addEventListener('pointercancel', () => { pressed = null; });
    search.addEventListener('click', (event) => {
      const before = event.detail !== 0 ? pressed : document.activeElement;
      pressed = null;
      close();
      find(before && before !== document.body && !before.closest('[hidden], [inert]') ? before : search);
    });
    owner.append(search);
  }
  owner.append(key, menu);
  return {key, set, close, drop: () => close()};
}

/** Document and issue desks use the same routes. */
export function workPlaces(owner: HTMLElement, select: (place: WorkPlace) => void, extra: () => readonly PlaceCommand[], find: Find) {
  const promptIsAction = owner.classList.contains('forge-layout');
  const menu = placesMenu(owner, WORK_PLACES, 'Forge', select, extra, {action: (place) => promptIsAction && place === 'Prompt', find});
  return {...menu, set: (place: WorkPlace, hasRepo: boolean) => {
    menu.set(place, (destination) => hasRepo || (destination !== 'Prompt' && destination !== 'Files'));
  }};
}
