import {searchScreen, type ResultPlace} from '../pages/bench/search-screen.ts';
import {pageVeil} from '../ui/page-veil.ts';
import {onRenamed, rekey} from '../../repo/repos.ts';

/** Search is a real history step of one desk, not a permanent purpose or shared URL. */
interface Visit {
  repo: string | null; origin: string | null; place: string; query: string;
  carry: () => void; seat: ((repo: string) => void) | null; result: ResultPlace | null;
}
interface Desk { element: HTMLElement; hidden: string | null }
interface Trail {
  surfaces(): HTMLElement[];
  files(repo: string): string[];
  seat(repo: string): ((name: string) => void) | null;
  restore(repo: string | null, place: string): void;
  open(repo: string, path: string, line: number, words: string): void;
  name(): void;
}

/** Leave an editor in the paper where it is, so its draft's Undo and selection are not reconstructed. */
function keep(origin: Element | null, rejoin?: () => HTMLElement | null) {
  const from = origin instanceof HTMLElement && origin !== document.body ? origin : null;
  const writing = from instanceof HTMLTextAreaElement || from instanceof HTMLInputElement
    ? {value: from.value, first: from.selectionStart, last: from.selectionEnd, direction: from.selectionDirection}
    : null;
  const scroll: [HTMLElement, number, number][] = [];
  for (let at: HTMLElement | null = from; at; at = at.parentElement) {
    if (at.scrollTop || at.scrollLeft || at.scrollHeight > at.clientHeight || at.scrollWidth > at.clientWidth)
      scroll.push([at, at.scrollLeft, at.scrollTop]);
  }
  const reachable = (el: HTMLElement | null | undefined): el is HTMLElement =>
    !!el?.isConnected && !el.closest('[hidden], [inert]') && !!el.getClientRects().length;
  return () => {
    const back = reachable(from) ? from : rejoin?.();
    if (!reachable(back)) return;
    back.focus({preventScroll: true});
    if (writing?.first != null && writing.last != null && (back instanceof HTMLTextAreaElement || back instanceof HTMLInputElement) && writing.value === back.value)
      back.setSelectionRange(writing.first, writing.last, writing.direction ?? undefined);
    for (const [at, x, y] of scroll) if (at.isConnected) { at.scrollLeft = x; at.scrollTop = y; }
  };
}

export class SearchTrail {
  private next = 0;
  private readonly here = performance.timeOrigin.toString(36);
  private visits = new Map<string, Visit>();
  private queries = new Map<string, string>();
  private opened = new Map<string, string[]>();
  private live: {screen: ReturnType<typeof searchScreen>; desks: Desk[]; id: string} | null = null;
  private readonly veil = pageVeil('deep');
  private leaving = false;

  private readonly way: Trail;
  constructor(way: Trail) {
    this.way = way;
    this.veil.element.classList.add('search-veil');
    onRenamed((from, to) => {
      rekey(this.queries, from, to);
      rekey(this.opened, from, to);
      for (const visit of this.visits.values()) {
        if (visit.repo === from) visit.repo = to;
        if (visit.origin === from) visit.origin = to;
      }
    });
  }
  get open() { return this.live !== null; }

  /** Don't store the repo or query in the address, or the browser's saved history. */
  start(repo: string | null, place: string, origin: Element | null, rejoin?: () => HTMLElement | null) {
    if (this.live) return;
    const id = `${this.here}:${++this.next}`;
    this.visits.set(id, {repo, origin: repo, place, query: (repo && this.queries.get(repo)) || '',
      carry: keep(origin, rejoin), seat: repo && place === 'forge' ? this.way.seat(repo) : null, result: null});
    if (this.visits.size > 24) this.visits.delete(this.visits.keys().next().value!);
    history.pushState({place, search: id}, '');
    this.enter(id);
  }

  step(value: unknown) {
    return typeof value === 'string' && this.visits.has(value) ? value : null;
  }

  origin(id: string) { return this.visits.get(id)?.origin ?? null; }

  enter(id: string) {
    if (this.live?.id === id) return;
    this.leave(false);
    const visit = this.visits.get(id);
    if (!visit) return;
    const files = (repo: string | null) => repo ? [...this.way.files(repo), ...(this.opened.get(repo) ?? [])] : [];
    const screen = searchScreen(visit.repo, visit.query, files(visit.repo), {
      matchQuery: visit.place === 'home',
      scope: (repo) => { visit.repo = repo; visit.result = null; return files(repo); },
      back: () => {
        if (this.leaving) return;
        this.leaving = true;
        history.back();
      },
      write: (query) => { visit.query = query; visit.result = null; if (visit.repo) this.queries.set(visit.repo, query); },
      open: (repo, path, line, words, result) => {
        if (this.leaving || visit.repo !== repo) return;
        visit.result = result;
        this.opened.set(repo, [...new Set([path, ...(this.opened.get(repo) ?? [])])].slice(0, 5));
        this.way.open(repo, path, line, words);
      },
    }, visit.result);
    const desks = this.way.surfaces().filter(el => !el.inert).map(element => ({element, hidden: element.getAttribute('aria-hidden')}));
    // Leave the work where it was. Home clears the desk; other places keep it behind the veil.
    for (const {element} of desks) element.inert = true;
    if (visit.place === 'home') screen.element.classList.add('search-on-home');
    else this.veil.out(true);
    document.body.append(screen.element);
    this.live = {screen, desks, id};
    this.way.name();
    screen.focus();
    for (const {element} of desks) element.setAttribute('aria-hidden', 'true');
  }

  leave(restore: boolean) {
    this.leaving = false;
    if (!this.live) return;
    const {screen, desks, id} = this.live;
    this.live = null;
    screen.close();
    this.veil.out(false);
    for (const {element, hidden} of desks) {
      if (hidden === null) element.removeAttribute('aria-hidden'); else element.setAttribute('aria-hidden', hidden);
      element.inert = false;
    }
    this.way.name();
    const visit = restore ? this.visits.get(id) : null;
    if (visit) {
      this.way.restore(visit.origin, visit.place);
      if (visit.origin) visit.seat?.(visit.origin);
      visit.carry();
    }
  }

  /** Repo history is private to the identity that typed it. */
  forget() { this.leave(false); this.visits.clear(); this.queries.clear(); this.opened.clear(); }
}
