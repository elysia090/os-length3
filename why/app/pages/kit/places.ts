import {h} from '../../ui/dom.ts';
import {mark} from '../../ui/icons.ts';
import {activateOnPress} from '../../ui/press.ts';
import {t} from '../../../text/i18n.ts';
import {marks, news, onNews, type News} from '../../../shipto/news.ts';

export const WORK_PLACES = ['Forge', 'Files', 'Git', 'Prompt'] as const;
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

function tellNews(at: HTMLElement, ...words: string[]) {
  const description = words.filter(Boolean).join(' · ');
  at.classList.toggle('places-news', !!description);
  if (description) at.setAttribute('aria-description', description);
  else at.removeAttribute('aria-description');
}

/** One ink dot, not a new destination. If Inbox is another step away, Server tells what waits on its far side. */
function paintNews(key: HTMLElement, menu: HTMLElement, state = news()) {
  const {inbox, server} = marks(state);
  const letters = inbox ? t('Unread messages in Inbox') : '', posts = server ? t('New posts in server') : '';
  tellNews(key, letters, posts);
  const inboxRow = menu.querySelector<HTMLElement>('[data-news-place="Inbox"]');
  if (inboxRow) tellNews(inboxRow, letters);
  const serverRow = menu.querySelector<HTMLElement>('[data-news-place="Server"]');
  if (serverRow) tellNews(serverRow, posts, inboxRow ? '' : letters);
}

// The shell already looks for news. Update the desks in this document; abandoned desks leave no listeners behind.
onNews((state: News) => {
  for (const key of document.querySelectorAll<HTMLElement>('#page .forge-places-key[aria-controls]')) {
    const menu = document.getElementById(key.getAttribute('aria-controls')!);
    if (menu?.classList.contains('forge-places')) paintNews(key, menu, state);
  }
});

/** Route the corner key to the same Search, using the repo of the desk in hand, if any. */
export function deskSearch(ctx: SearchDesk, repo: () => string | null = () => ctx.repo): Find {
  return (origin) => ctx.searchRepo?.(repo(), origin, () => document.querySelector<HTMLElement>('#page .forge-search-key'));
}

/** The place name opens its destinations. An existing masthead keeps its heading semantics. */
export function placesMenu<K extends string>(owner: HTMLElement, places: readonly K[], start: K, select: (place: K) => void,
  extra: () => readonly PlaceCommand[], {action = () => false, find}: PlaceKeys<K> = {}) {
  const id = `work-places-${++made}`;
  const label = h('span', {class: 'places-label', 'data-press-face': ''}, t(start));
  const key = h('button', {class: 'forge-places-key', type: 'button', 'aria-haspopup': 'menu',
    'aria-controls': id, 'aria-expanded': 'false'}, label) as HTMLButtonElement;
  const caption = owner.querySelector<HTMLElement>(':scope > h1') ?? h('div', {});
  if (!caption.parentNode) owner.prepend(caption);
  caption.classList.add('desk-caption');
  caption.replaceChildren(key);
  const menu = h('div', {class: 'forge-places', id, role: 'menu', 'aria-label': t('Places'), hidden: ''});
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
  // The quiet ground takes an outside press itself; the work underneath does not receive a second deed.
  const ground = (e: Event) => e.target === caption && !menu.hidden;
  caption.addEventListener('pointerdown', e => { if (ground(e) && e.isPrimary && e.button === 0) e.preventDefault(); });
  caption.addEventListener('click', e => { if (ground(e)) close(true); });
  caption.addEventListener('wheel', e => { if (ground(e)) e.preventDefault(); }, {passive: false});
  const item = (name: string, role: string, go: () => void, onPress = false) => {
    const b = h('button', {class: 'forge-menu-item', type: 'button', role, tabindex: '-1', 'aria-label': t(name)},
      h('span', {'data-press-face': ''}, t(name))) as HTMLButtonElement;
    if (name === 'Inbox' || name === 'Server') b.dataset.newsPlace = name;
    if (onPress) activateOnPress(b, go);
    else b.addEventListener('click', go);
    menu.append(b);
    return b;
  };
  const tabs = places.map((place) => {
    const acts = action(place);
    return item(place, acts ? 'menuitem' : 'menuitemradio', () => {
      close(true);
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
    label.textContent = t(place);
    tabs.forEach((b, i) => {
      const destination = places[i];
      if (!action(destination)) b.setAttribute('aria-checked', String(destination === place));
      b.disabled = !available(destination);
    });
  };
  set(start);
  paintNews(key, menu);
  const beside = () => menu.style.setProperty('--places-key-right', `${key.getBoundingClientRect().right}px`);
  key.addEventListener('click', () => {
    if (!menu.hidden) { close(true); return; }
    commands.forEach((button) => button.remove());
    commands = extra().map(({label, run, onPress}) => item(label, 'menuitem', () => { close(true); run(key); }, onPress));
    paintNews(key, menu);
    beside();
    menu.hidden = false;
    key.setAttribute('aria-expanded', 'true');
    menu.dataset.keys = '';
    menu.scrollTop = 0;
    const current = tabs[places.indexOf(here)];
    focus(current && !current.disabled ? current : items()[0]);
    const {signal} = listening = new AbortController();
    const fit = new ResizeObserver(beside);
    fit.observe(key);
    signal.addEventListener('abort', () => fit.disconnect(), {once: true});
    window.addEventListener('resize', beside, {signal});
    document.addEventListener('pointerdown', (e) => {
      if (e.target instanceof Node && !menu.contains(e.target) && !caption.contains(e.target)) close();
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
    const lens = mark('search');
    lens.setAttribute('data-press-face', '');
    const search = h('button', {class: 'forge-search-key', type: 'button', 'aria-label': t('Search')}, lens);
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
  owner.append(menu);
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
