import {cutWhenLonger} from '../../ui/cut.ts';
import {h} from '../../ui/dom.ts';
import {after, arrive, closeUp, paneIn, paneOut} from '../../ui/glide.ts';
import {t} from '../../i18n/i18n.ts';
import * as inbox from '../../remote/inbox.ts';
import {news, onNews} from '../../remote/news.ts';
import {onPlugins, pluginsOpen, setPluginsOpen, slots} from '../../host/plugins.ts';
import {connection} from '../../remote/connection.ts';
import {kindWords} from './todo-list.ts';

// The right pane beside the center (Forge's, Git's, Home's): what the center refers to, the plugin area at its top,
// the Prompt under it, a conversation's word at its foot. Put away, the center takes the whole width, and everything
// in the pane stays as it was (what was chosen there, where it was read), only out of sight; put away or brought back
// on one page, it is so on every page. Narrow, it is laid over the center when it is brought out, and goes with
// Escape or a press outside it.

const PANE_KEY = 'root3.os.pane';
/** Whether the right pane is out when the window is wide, as last left on this device: one for every page that has it. */
let paneOpen = (() => { try { return localStorage.getItem(PANE_KEY) !== 'closed'; } catch { return true; } })();
const paneHearers = new Set<() => void>();
/** Whether the right pane is out (wide windows), on any page that has one (Forge, Git, Home). */
export const rightPaneOpen = () => paneOpen;
/** The right pane put away or brought back, on every page that has one. */
export function setRightPane(on: boolean) {
  if (on === paneOpen) return;
  paneOpen = on;
  try { localStorage.setItem(PANE_KEY, on ? 'open' : 'closed'); } catch { /* a convenience */ }
  for (const f of [...paneHearers]) f();
}
export function onRightPane(f: () => void): () => void { paneHearers.add(f); return () => paneHearers.delete(f); }

/** One page's right pane: its side and its switch, on the page's `work`. */
export class Pane {
  readonly #narrow = matchMedia('(max-width: 760px)');
  /** Narrow, whether the pane is laid over the center now (never on its own: only when asked for). */
  #over = false;
  #wasShown: boolean;
  #moving: Animation | null = null;

  readonly #work: HTMLElement;
  readonly #side: HTMLElement;
  readonly #toggle: HTMLButtonElement;
  readonly #fixed: boolean;

  constructor(work: HTMLElement, side: HTMLElement, toggle: HTMLButtonElement, options: {fixed?: boolean} = {}) {
    this.#fixed = !!options.fixed;
    this.#work = work;
    this.#side = side;
    this.#toggle = toggle;
    this.#wasShown = this.shown;
    // Put away or brought back on another page (Home's), it is so here too.
    const off = onRightPane(() => { if (!work.isConnected && work.dataset.shown) { off(); return; } this.paint(); });
    toggle.addEventListener('click', () => this.set(!this.shown));
    // The plugin area is the pane's top: brought out by the plug, it brings the pane out with it.
    const offPlug = onPlugins(() => { if (!work.isConnected && work.dataset.shown) { offPlug(); return; } if (pluginsOpen()) this.set(true); });
    this.#narrow.addEventListener('change', () => { this.#over = false; this.paint(); });
    // Laid over the center, it goes with Escape (the keyboard back on the switch) or a press outside it.
    side.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.#over || event.defaultPrevented) return;
      event.preventDefault();
      this.set(false);
      if (toggle.isConnected) toggle.focus();
      else work.querySelector<HTMLElement>('.flow')?.focus();
    });
    document.addEventListener('pointerdown', (event) => {
      const at = event.target as Node;
      if (this.#over && !side.contains(at) && !toggle.contains(at)) this.set(false);
    });
    this.paint();
  }

  get narrow(): boolean { return this.#narrow.matches; }
  /** Whether the pane is out: laid over the center when narrow, beside it when wide. */
  get shown(): boolean { return this.narrow ? this.#over : this.#fixed || paneOpen; }

  set(on: boolean) {
    if (on === this.shown || this.#fixed && !this.narrow) return;
    if (this.narrow) { this.#over = on; this.paint(); } else setRightPane(on);
  }

  paint() {
    const work = this.#work, side = this.#side, toggle = this.#toggle;
    // Brought back before it had gone (the switch pressed again on the way): what it holds is still there, and stays.
    const there = !this.narrow && work.isConnected && getComputedStyle(side).visibility === 'visible';
    // Put away or brought back, what stands beside it moves on its curve while it moves (styles.css .pane-moving).
    if (work.classList.contains('pane-closed') === (this.#fixed || paneOpen)) {
      work.classList.add('pane-moving');
      this.#moving?.cancel();
      this.#moving = after(460, () => work.classList.remove('pane-moving'));
    }
    work.classList.toggle('pane-closed', !this.#fixed && !paneOpen);
    work.classList.toggle('pane-out', this.#over);
    toggle.setAttribute('aria-expanded', String(this.shown));
    // Brought out (here, or on another page while this one is shown): what it holds comes in after its edge.
    // Wide, its search on the top line went with it, and comes back with its words; narrow, it stayed.
    if (this.shown && !this.#wasShown && work.isConnected) paneOut(side, toggle, this.narrow ? null : work.querySelector<HTMLElement>(':scope > .bar > .search-box'), !there);
    // Put away while what it holds was still coming in: that goes with it as it is.
    if (!this.shown && this.#wasShown) paneIn(side);
    this.#wasShown = this.shown;
  }
}

/**
 * The plugin area: nothing until it is opened; opened, the plugins side by side (one in full, ← → or an edge to
 * the next). With none, it stays plain: nothing is put there to fill it (issue #45), the rail's plug is the way in.
 */
export function pluginArea(): HTMLElement {
  const area = h('section', {class: 'plugins', 'aria-label': t('Plugins'), hidden: ''});
  const paint = () => {
    // Put away, what is under it comes up into its place; opened, it comes down into its own.
    const was = area.hidden ? 0 : area.getBoundingClientRect().height;
    area.hidden = !pluginsOpen();
    if (area.hidden) {
      if (was && area.nextElementSibling) closeUp([area.nextElementSibling], was, 260);
      return;
    }
    const list = slots.all;
    if (!list.length) { area.replaceChildren(); return; }
    const at = slots.shown;
    const track = h('div', {class: 'slide-track', style: `--at:${at}`}, ...list.map((s, i) =>
      h('div', {class: 'slide', role: 'group', 'aria-label': s.label, 'aria-current': String(i === at)}, s.make())));
    const edge = (by: 1 | -1) => {
      const b = h('button', {type: 'button', class: `stage-hit ${by > 0 ? 'next' : 'prev'}`, 'aria-label': list[at + by]?.label ?? ''});
      b.hidden = !list[at + by];
      b.addEventListener('click', () => { slots.step(by); paint(); });
      return b;
    };
    const stage = h('div', {class: 'slide-stage', tabindex: '0', 'aria-label': t('Plugins')}, track, edge(-1), edge(1));
    stage.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); setPluginsOpen(false); return; }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      slots.step(event.key === 'ArrowRight' ? 1 : -1);
      paint();
      area.querySelector<HTMLElement>('.slide-stage')?.focus();
    });
    area.replaceChildren(h('div', {class: `slides${list.length === 1 ? ' single' : ''}`, style: `--lead:${at ? 1 : 0}`}, stage));
    if (!was && area.dataset.shown) arrive(area, -1, 'y', 10, 280);
  };
  const off = onPlugins(() => { if (!area.isConnected && area.dataset.shown) { off(); return; } paint(); });
  paint();
  requestAnimationFrame(() => { area.dataset.shown = '1'; });
  return area;
}

/** Someone, as a round initial on their soft tint (the same for the same name): Lately, the pane's word, Inbox, Server's people. */
export function personBadge(who: string): HTMLElement {
  const tint = [...who].reduce((n, c) => n + c.codePointAt(0)!, 0) % 4;
  return h('span', {class: 'lately-badge', 'data-tint': String(tint), 'aria-hidden': 'true'}, [...who.trim()][0]?.toUpperCase() ?? '?');
}

/**
 * A row of what waits, as Home's Lately and the bench's pane both show it, in the rows the pane has for what was done
 * (bench/rows.ts): a bar (ink while something of it is not read, quiet once it is), what it is in the display face (a
 * file, who wrote, a board), under it what was said or the line it was left at (two lines at most, the second fading
 * out), and where it is, quiet. Pressed, it goes to where the thing is done (a conversation, a board, the line).
 */
export function latelyRow(what: string, line: Node[] | string, o: {fresh?: boolean; quote?: string; heard?: boolean; place?: string; go(): void}): HTMLButtonElement {
  const words = typeof line === 'string' ? [line] : line;
  // A quoted line says where it was left better than words would; where what it is and where say it all (`heard`),
  // nothing is said under them. Either way the words are heard only.
  const said = o.quote ? h('span', {class: 'pane-said quote'}, o.quote) : o.heard ? null : h('span', {class: 'pane-said'}, ...words);
  const b = h('button', {type: 'button', class: 'pane-row news', 'data-state': o.fresh ? 'fresh' : 'seen'},
    h('span', {class: 'pane-bar', 'aria-hidden': 'true'}), h('span', {class: 'pane-line'}, what), said,
    o.place ? h('span', {class: 'pane-at'}, o.place) : null,
    o.quote || o.heard ? h('span', {class: 'sr-only'}, ...words) : null) as HTMLButtonElement;
  b.addEventListener('click', () => o.go());
  // Cut at two lines, the second fading out, when what it says is longer.
  cutWhenLonger(b.querySelector<HTMLElement>('.pane-line')!);
  if (said) cutWhenLonger(said);
  return b;
}

/** A conversation's last word as a row says it: named as it was written (Review：…, Question：…), then its first line. */
export const wordLine = (th: inbox.Thread): Node[] => {
  // A notice the Remote left is said as the reader says it, not by the words it was kept with.
  const notice = inbox.noticeWords(th.last.target, th.last.mine, th.name || inbox.shown(th.address));
  if (notice) return [document.createTextNode(notice)];
  return [...(th.last.type === 'message' ? [] : kindWords(th.last.type[0].toUpperCase() + th.last.type.slice(1))), document.createTextNode(th.last.body.split('\n')[0])];
};

/** Word that waits, as Home's Lately and the bench's pane both pick it: conversations not read whose last word is not one's own, newest first. */
export const waiting = (threads: inbox.Thread[], most: number) =>
  threads.filter((x) => x.unread > 0 && !x.last.mine).sort((a, b) => b.last.time - a.last.time).slice(0, most);

/** The conversations whose last word has come into a pane already (the next pane shows it standing, not arriving). */
const arrived = new Set<string>();

/**
 * Word from someone that waits, while one works: at the pane's foot, level with the prompt box, the same rows as Home's
 * Lately (the two newest, there being less room), who and the first line of what they said, sliding in from the
 * window's edge as it comes. Pressed, the conversation in Inbox (`open`). Read, it goes.
 */
export function paneWord(open: (address: string) => void): HTMLElement {
  const list = h('section', {class: 'pane-word', 'aria-label': t('New messages')});
  let asked = 0;
  const paint = async () => {
    const mine = ++asked;
    const come = connection() && news().inbox > 0
      ? waiting(await inbox.threads().catch(() => []), 2) : [];
    if (mine !== asked) return;
    const rows = come.map((th) => {
      const who = th.name || inbox.shown(th.address);
      // The same row as Home's Lately: who and their first line; pressed, the conversation in Inbox.
      const b = latelyRow(who, wordLine(th), {fresh: true, go: () => open(th.address)});
      return {b, key: `${th.address} ${th.last.time}`};
    });
    list.replaceChildren(...rows.map((r) => r.b));
    // It arrives in the pane on the screen: a page's pane out of sight (hearing the same news first) never takes the
    // arrival for itself, leaving the one seen to show it standing in a frame.
    if (!list.getClientRects().length) return;
    for (const r of rows) if (!arrived.has(r.key)) { arrived.add(r.key); arrive(r.b, 1, 'x', 32, 360); }
  };
  void paint();
  const off = onNews(() => { if (!list.isConnected && list.dataset.shown) { off(); return; } void paint(); });
  list.addEventListener('look-closed', () => void paint());
  requestAnimationFrame(() => { list.dataset.shown = '1'; });
  return list;
}
