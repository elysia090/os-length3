import {h} from '../../ui/dom.ts';
import {mark} from '../../ui/icons.ts';
import {activateOnPress} from '../../ui/press.ts';
import {PLACE_PAGES, placeStep, purpose, type PlacePage, type PurposeId} from '../../host/purposes.ts';
import {t} from '../../../text/i18n.ts';
import {marks, news, onNews, type News} from '../../../shipto/news.ts';

export const WORK_PLACES = ['Forge', 'Files', 'Git', 'Prompt'] as const;
export type WorkPlace = typeof WORK_PLACES[number];
export type ForgePlace = Exclude<WorkPlace, 'Git'>;
export interface PlaceCommand {
  label: string;
  run(anchor: HTMLElement): void;
  onPress?: boolean;
}

type Find = (origin: Element | null) => void;

export interface SearchDesk {
  /** The repo in the hand, if any; an empty search can still look for an actual local scope. */
  readonly repo: string | null;
  searchRepo?(repo: string | null, origin?: Element | null, rejoin?: () => HTMLElement | null): void;
}
interface PlaceKeys {
  /** A label can also name this page's contextual view (e.g. Files within Forge). */
  onCurrent?: () => void;
  commands?: () => readonly PlaceCommand[];
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
export function placesMenu(owner: HTMLElement, page: PurposeId, select: (place: PlacePage) => void,
  {onCurrent, find, commands}: PlaceKeys = {}) {
  const start = purpose(page).label;
  const id = `work-places-${++made}`;
  const label = h('span', {class: 'places-label', 'data-press-face': ''}, t(start));
  const key = h('button', {class: 'forge-places-key', type: 'button', 'aria-haspopup': 'menu',
    'aria-controls': id, 'aria-expanded': 'false'}, label) as HTMLButtonElement;
  const caption = owner.querySelector<HTMLElement>(':scope > h1') ?? h('div', {});
  if (!caption.parentNode) owner.prepend(caption);
  caption.classList.add('desk-caption');
  const veil = h('span', {class: 'page-veil places-veil', 'aria-hidden': 'true'});
  caption.replaceChildren(key, veil);
  if (commands) key.setAttribute('aria-keyshortcuts', 'Shift+F10');
  const menu = h('div', {class: 'forge-places', id, role: 'menu', 'aria-label': t('Places'), hidden: ''});
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
  const ground = (e: Event) => e.target === veil && !menu.hidden;
  caption.addEventListener('pointerdown', e => { if (ground(e) && e.isPrimary && e.button === 0) e.preventDefault(); });
  caption.addEventListener('click', e => { if (ground(e)) close(true); });
  caption.addEventListener('wheel', e => { if (ground(e)) e.preventDefault(); }, {passive: false});
  const tabs = PLACE_PAGES.map((place) => {
    const name = purpose(place).label;
    const b = h('button', {class: 'forge-menu-item', type: 'button', role: 'menuitemradio', tabindex: '-1',
      'aria-label': t(name), 'aria-checked': String(page === place)},
      h('span', {'data-press-face': ''}, t(name))) as HTMLButtonElement;
    if (place === 'inbox' || place === 'server') b.dataset.newsPlace = name;
    b.addEventListener('click', () => {
      close(true);
      if (page === place) onCurrent?.();
      else select(place);
    });
    menu.append(b);
    return b;
  });
  const pageLabels = new Set(PLACE_PAGES.map(id => purpose(id).label));
  const commandRows = () => (commands?.() ?? []).filter(c => !pageLabels.has(c.label)).map(({label, run, onPress}) => {
    const button = h('button', {class: 'forge-menu-item', type: 'button', role: 'menuitem', tabindex: '-1', 'aria-label': t(label)},
      h('span', {'data-press-face': ''}, t(label))) as HTMLButtonElement;
    const go = () => { close(true); run(key); };
    if (onPress) activateOnPress(button, go);
    else button.addEventListener('click', go);
    return button;
  });
  let rows = tabs;
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
  const set = (labelName: string) => { label.textContent = t(labelName); };
  paintNews(key, menu);

  const step = (direction: -1 | 1) => {
    const destination = placeStep(page, direction);
    if (destination) {
      key.focus({preventScroll: true});
      select(destination);
    }
  };
  // Touch belongs to this key only: a short tap opens Places, a stationary hold gets the same Tools as
  // contextmenu, and a horizontal drag steps sideways. Native vertical pan, pinch zoom, and editors stay alone.
  const canStep = tabs.some(tab => tab.getAttribute('aria-checked') === 'true');
  if (canStep) key.classList.add('places-step');
  let touch: {id: number; x: number; y: number} | null = null;
  let suppressClick = false;
  let holding = 0;
  const stopHold = () => { clearTimeout(holding); holding = 0; };
  key.addEventListener('pointerdown', (e) => {
    stopHold();
    if (!e.isPrimary) return;
    suppressClick = false;
    if (e.pointerType !== 'touch' || !menu.hidden || !canStep && !commands) return;
    touch = {id: e.pointerId, x: e.clientX, y: e.clientY};
    if (commands) holding = window.setTimeout(() => {
      if (touch?.id !== e.pointerId || !menu.hidden || !key.isConnected || key.closest('[hidden], [inert]')) return;
      if (open(true)) { touch = null; suppressClick = true; }
    }, 550);
  });
  key.addEventListener('pointermove', (e) => {
    if (touch?.id === e.pointerId && (Math.abs(e.clientX - touch.x) > 9 || Math.abs(e.clientY - touch.y) > 9)) stopHold();
  });
  key.addEventListener('pointercancel', (e) => {
    if (touch?.id === e.pointerId) { stopHold(); touch = null; }
  });
  key.addEventListener('pointerup', (e) => {
    if (touch?.id !== e.pointerId) return;
    stopHold();
    const x = e.clientX - touch.x, y = e.clientY - touch.y;
    touch = null;
    if (!canStep || !menu.hidden || Math.abs(x) < 38 || Math.abs(x) < Math.abs(y) * 1.5) return;
    suppressClick = true;
    step(x < 0 ? 1 : -1);
  });
  const open = (tools: boolean) => {
    const next = tools ? commandRows() : tabs;
    if (!next.length) return false;
    if (!menu.hidden) close();
    rows = next;
    menu.replaceChildren(...rows);
    menu.setAttribute('aria-label', t(tools ? 'Tools' : 'Places'));
    paintNews(key, menu);
    menu.hidden = false;
    key.setAttribute('aria-expanded', 'true');
    menu.dataset.keys = '';
    menu.scrollTop = 0;
    focus(rows.find(tab => tab.getAttribute('aria-checked') === 'true') ?? rows[0]);
    const {signal} = listening = new AbortController();
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
    return true;
  };
  key.addEventListener('click', (e) => {
    if (e.detail && suppressClick) { suppressClick = false; return; }
    if (!menu.hidden) close(true);
    else open(false);
  });
  if (commands) {
    key.addEventListener('contextmenu', e => {
      if ((menu.hidden || rows === tabs) && !open(true)) return;
      e.preventDefault();
      if (touch || e instanceof PointerEvent && e.pointerType === 'touch') {
        stopHold(); touch = null; suppressClick = true;
      }
    });
    key.addEventListener('keydown', e => {
      if (e.defaultPrevented || e.isComposing || e.repeat || (e.key !== 'ContextMenu' && !(e.shiftKey && e.key === 'F10'))) return;
      if (open(true)) e.preventDefault();
    });
  }
  const pointerScroll = () => { delete menu.dataset.keys; };
  menu.addEventListener('wheel', pointerScroll, {passive: true});
  menu.addEventListener('pointerdown', pointerScroll, {passive: true});
  menu.addEventListener('keydown', (e) => {
    const all = rows;
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

/** Document and issue desks use the same six page routes and keep their contextual Search key. */
export function workPlaces(owner: HTMLElement, page: 'forge' | 'git', select: (page: PlacePage) => void,
  find: Find, options: Omit<PlaceKeys, 'find'> = {}) {
  return placesMenu(owner, page, select, {find, ...options});
}
