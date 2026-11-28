import {currentLang, t} from '../../../text/i18n.ts';
import {arrowKeys, h} from '../../ui/dom.ts';

/** A real place to return to. Missing timestamps stay missing rather than acquiring the refresh's date. */
export type RecentLine = {
  key: string; title: string | Node[]; source: string; at?: number; hint?: string; go(): void;
};

const PEEK = 3;
const dayOf = (date: Date) => [date.getFullYear(), date.getMonth(), date.getDate()].join('/');
const dated = (at: number | undefined): at is number => at !== undefined && Number.isFinite(at) && at >= 0 && at < 8.64e15;

/** The Remote's board post IDs carry their real time: nine base-36 digits followed by eight random digits. */
export const boardPostTime = (id: string): number | undefined => /^[0-9a-z]{17}$/.test(id) ? Number.parseInt(id.slice(0, 9), 36) : undefined;

let sequence = 0;
/** A short view of the same list, not a second history or a second set of destinations. */
export function recentList() {
  const id = `home-recent-window-${++sequence}`;
  const items = h('div', {class: 'home-recent-items'});
  const list = h('div', {class: 'lately-list home-recent-window', id, role: 'region', 'aria-label': t('Activity timeline')}, items);
  const more = h('button', {class: 'home-recent-more', type: 'button', 'aria-controls': id, hidden: ''}) as HTMLButtonElement;
  const thumb = h('span', {class: 'home-recent-thumb', 'aria-hidden': 'true', hidden: ''});
  const element = h('div', {class: 'home-recent-view'}, list, thumb, more);
  arrowKeys(list, '.home-recent-line');
  let expanded = false, rows: HTMLButtonElement[] = [];
  let days: HTMLElement[] = [];

  function sync() {
    const available = list.clientHeight, max = list.scrollHeight - available;
    const scrolls = expanded && getComputedStyle(list).overflowY === 'auto' && max > 0;
    thumb.hidden = !scrolls;
    if (scrolls) list.tabIndex = 0;
    else list.removeAttribute('tabindex');
    const top = list.getBoundingClientRect().top, end = top + available;
    // Keep the border's place even when the next date has not come into view with it yet.
    for (const day of days) {
      const heading = day.firstElementChild;
      if (!heading || heading.tagName !== 'H3') continue;
      const y = day.getBoundingClientRect().top;
      day.toggleAttribute('data-orphan-rule', scrolls && !day.hidden && y >= top && y < end && heading.getBoundingClientRect().bottom > end);
    }
    if (!scrolls) return;
    const size = Math.min(available, Math.max(28, available * available / list.scrollHeight));
    thumb.style.setProperty('--recent-thumb-size', `${size}px`);
    thumb.style.setProperty('--recent-thumb-top', `${(available - size) * list.scrollTop / max}px`);
  }

  function reveal() {
    if (rows.length <= PEEK) expanded = false;
    element.dataset.expanded = String(expanded);
    rows.forEach((row, i) => { row.hidden = !expanded && i >= PEEK; });
    for (const day of days) day.hidden = !day.querySelector('.home-recent-line:not([hidden])');
    more.hidden = rows.length <= PEEK;
    more.textContent = expanded ? `${t('Show less')} ↑` : `${t('Earlier {n}', {n: rows.length - PEEK})} ↓`;
    more.setAttribute('aria-expanded', String(expanded));
    sync();
  }

  more.addEventListener('click', () => {
    expanded = !expanded;
    list.scrollTop = 0;
    reveal();
    if (!expanded) more.focus({preventScroll: true});
    else if (list.tabIndex === 0) list.focus({preventScroll: true});
    else rows[PEEK]?.focus({preventScroll: true});
  });
  list.addEventListener('scroll', sync, {passive: true});
  const sized = new ResizeObserver(sync);
  sized.observe(list);
  sized.observe(items);
  thumb.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    thumb.setPointerCapture(e.pointerId);
    const y = e.clientY, from = list.scrollTop;
    const travel = list.clientHeight - thumb.getBoundingClientRect().height;
    const max = list.scrollHeight - list.clientHeight;
    const move = (next: PointerEvent) => { if (travel > 0) list.scrollTop = from + (next.clientY - y) * max / travel; };
    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('lostpointercapture', () => thumb.removeEventListener('pointermove', move), {once: true});
  });

  function show(lines: RecentLine[], reset = false) {
    const focus = !reset && list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.recentKey : undefined;
    const scrollTop = reset ? 0 : list.scrollTop;
    if (reset) expanded = false;
    const locale = currentLang();
    const today = new Date(), yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    const short = new Intl.DateTimeFormat(locale, {month: 'short', day: 'numeric'});
    const year = new Intl.DateTimeFormat(locale, {month: 'short', day: 'numeric', year: 'numeric'});
    const clock = new Intl.DateTimeFormat(locale, {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
    const groups = new Map<string, HTMLElement>();
    rows = [...lines].sort((a, b) => (dated(b.at) ? b.at : -1) - (dated(a.at) ? a.at : -1)).map(line => {
      const date = dated(line.at) ? new Date(line.at) : undefined;
      const key = date ? dayOf(date) : '';
      let group = groups.get(key);
      if (!group) {
        const name = date ? key === dayOf(today) ? t('Today') : key === dayOf(yesterday) ? t('Yesterday')
          : (date.getFullYear() === today.getFullYear() ? short : year).format(date) : '';
        group = h('div', {class: date ? 'home-recent-day' : 'home-recent-undated'}, name ? h('h3', {}, name) : null);
        groups.set(key, group);
      }
      const words = typeof line.title === 'string' ? [line.title] : line.title;
      const button = h('button', {type: 'button', class: 'home-recent-line', 'data-recent-key': line.key},
        date ? h('time', {class: 'home-recent-time', datetime: date.toISOString()}, clock.format(date)) : h('span', {'aria-hidden': 'true'}),
        h('span', {class: 'home-recent-words'}, h('span', {class: 'home-recent-title'}, ...words),
          h('span', {class: 'home-recent-source'}, line.source), line.hint ? h('span', {class: 'sr-only'}, line.hint) : null),
        h('span', {class: 'home-recent-arrow', 'aria-hidden': 'true'}, '→')) as HTMLButtonElement;
      button.addEventListener('click', line.go);
      group.append(button);
      return button;
    });
    days = [...groups.values()];
    items.replaceChildren(...days);
    reveal();
    list.scrollTop = scrollTop;
    const returned = focus ? rows.find(row => row.dataset.recentKey === focus && !row.hidden) : undefined;
    if (returned) returned.focus({preventScroll: true});
    else if (focus && !more.hidden) more.focus({preventScroll: true});
  }
  return {element, list, show};
}
