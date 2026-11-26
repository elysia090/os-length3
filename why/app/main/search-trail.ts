import {searchScreen} from '../pages/bench/search-screen.ts';
import {onRenamed, rekey} from '../../repo/repos.ts';

/** Search is a real history step of a particular work desk, not a permanent purpose or shared URL. */
interface Visit { repo: string; origin: string; place: string; query: string; carry: () => void }
interface Trail {
  surfaces(): HTMLElement[];
  files(repo: string): string[];
  restore(repo: string, place: string): void;
  open(repo: string, path: string, line: number): void;
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
  return () => {
    const back = from?.isConnected ? from : rejoin?.();
    if (!back || back.closest('[hidden], [inert]') || !back.getClientRects().length) return;
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
  private live: {screen: ReturnType<typeof searchScreen>; desks: HTMLElement[]; id: string} | null = null;
  private leaving = false;

  private readonly way: Trail;
  constructor(way: Trail) {
    this.way = way;
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
  start(repo: string, place: string, origin: Element | null, rejoin?: () => HTMLElement | null) {
    if (this.live) return;
    const id = `${this.here}:${++this.next}`;
    this.visits.set(id, {repo, origin: repo, place, query: this.queries.get(repo) ?? '', carry: keep(origin, rejoin)});
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
    const files = (repo: string) => [...this.way.files(repo), ...(this.opened.get(repo) ?? [])];
    const screen = searchScreen(visit.repo, visit.query, files(visit.repo), {
      scope: (repo) => { visit.repo = repo; return files(repo); },
      back: () => {
        if (this.leaving) return;
        this.leaving = true;
        history.back();
      },
      write: (query) => { visit.query = query; this.queries.set(visit.repo, query); },
      open: (repo, path, line) => {
        if (this.leaving || visit.repo !== repo) return;
        this.opened.set(repo, [...new Set([path, ...(this.opened.get(repo) ?? [])])].slice(0, 5));
        this.way.open(repo, path, line);
      },
    });
    const desks = this.way.surfaces().filter(el => !el.inert);
    for (const el of desks) { el.inert = true; el.dataset.searchAway = ''; }
    document.body.append(screen.element);
    this.live = {screen, desks, id};
    this.way.name();
    screen.focus();
  }

  leave(restore: boolean) {
    this.leaving = false;
    if (!this.live) return;
    const {screen, desks, id} = this.live;
    this.live = null;
    screen.close();
    for (const el of desks) { el.inert = false; delete el.dataset.searchAway; }
    this.way.name();
    const visit = restore ? this.visits.get(id) : null;
    if (visit) { this.way.restore(visit.origin, visit.place); visit.carry(); }
  }

  /** Repo history is private to the identity that typed it. */
  forget() { this.leave(false); this.visits.clear(); this.queries.clear(); this.opened.clear(); }
}
