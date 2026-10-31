import {h} from '../../ui/dom.ts';
import {mark} from '../../ui/icons.ts';
import {glide, still, where} from '../../ui/glide.ts';
import {t} from '../../i18n.ts';
import {shown as named} from '../../remote/inbox.ts';
import * as servers from '../../remote/servers.ts';
import {serverNew} from '../../remote/news.ts';
import type {Here, Shown} from './parts.ts';

// Server's top line, its band. + makes a server: first, at the band's left end, before the servers, which come and
// go to its right and so never move it; the one being named stands where it will once made, and after the servers,
// the boards one writes in as a guest, each alone. The gear changes the one chosen: at the top line's right end,
// where Forge's pane switch is, over the people and repos it changes; with none chosen it keeps its place,
// unpressable. What came in a server and was not seen yet is a dot on its chip.
//
// However many servers, the chips are one row that slides sideways, as Git's repos are, never more rows pushing the
// boards down (a phone's width took six); its ends fade where there is more along it, and the one chosen, or being
// named, is slid into view. What the Remote says no to, naming one, is a line of its own under the band, where the
// row cannot slide it out of sight.

/** What the band's presses do. */
interface BandWays {
  /** A server's chip: that server, at the board last seen in it. */
  show(id: string): void;
  /** A guest's chip: that board, alone. */
  showAlone(b: Shown): void;
  /** +: a server made. */
  make(): void;
  /** The gear: behind it, or back from there. */
  gear(): void;
}

export class Band {
  /** The top line: + and the chips. */
  readonly element: HTMLElement;
  /** The gear, at the top line's right end (in the page's bar, beside the side). */
  readonly gear: HTMLButtonElement;
  private readonly chips: HTMLElement;
  private readonly plus: HTMLButtonElement;
  private readonly here: Here;
  private readonly ways: BandWays;

  constructor(here: Here, ways: BandWays) {
    this.here = here;
    this.ways = ways;
    this.chips = h('div', {class: 'chips server-chips', role: 'radiogroup', 'aria-label': 'Server'});
    this.gear = h('button', {type: 'button', class: 'server-gear unseen', 'aria-label': t('Manage members, boards, and repos'), title: t('Manage members, boards, and repos'), 'aria-expanded': 'false', disabled: ''}, mark('gear')) as HTMLButtonElement;
    this.plus = h('button', {type: 'button', class: 'band-add', 'aria-label': t('Create server'), title: t('Create server'), hidden: ''}, mark('plus')) as HTMLButtonElement;
    this.plus.addEventListener('click', () => ways.make());
    this.gear.addEventListener('click', () => ways.gear());
    this.element = h('div', {class: 'server-top'}, this.plus, this.chips, this.said);
    this.chips.addEventListener('scroll', () => this.ends(), {passive: true});
    // Narrowed (a window, a phone turned), the one chosen stays in view.
    new ResizeObserver(() => this.inView()).observe(this.chips);
  }

  /** Under the band: what the Remote said no to, naming a server. */
  private readonly said = h('div', {class: 'server-said'});
  private asked: HTMLElement | null = null;
  /** What the Remote says no to about the server being named: said under the band while it is named. */
  asking(ask: HTMLElement) { this.asked = ask; }

  /** Drawn again for what is chosen now. Signed out there are no servers of one's own: the band says what is shown. */
  paint() {
    const {serverId, signedIn} = this.here;
    this.gear.disabled = !serverId;
    this.gear.classList.toggle('unseen', !serverId);
    this.plus.hidden = !signedIn;
    this.said.replaceChildren(...(this.here.naming && this.asked ? [this.asked] : []));
    if (!signedIn) { this.chips.replaceChildren(h('span', {class: 'muted'}, t('Public boards'))); return; }
    const each = this.here.list.map((s) => {
      const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(s.id === serverId), title: `${named(s.address)} · ${s.code}`, 'data-server': s.id}, s.name);
      markChip(b, this.here.list);
      b.addEventListener('click', () => this.ways.show(s.id));
      return b;
    });
    // The ink goes from the chip it was on to the one chosen now, as along the rail and Forge's band.
    const was = where(this.chips.querySelector('[aria-checked="true"]'));
    // The chip being named is moved, not made again: the keyboard in it (the list read again as it is written) stays.
    const typing = this.here.naming?.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    this.chips.replaceChildren(...each, ...(this.here.naming ? [this.here.naming] : []), ...this.guesting());
    typing?.focus({preventScroll: true});
    glide(was, this.chips.querySelector<HTMLElement>('[aria-checked="true"]'), this.chips, 'var(--r-round)');
    requestAnimationFrame(() => this.inView());
  }

  /** The band drawn before: from then on, the row slides to what comes into view rather than jumping. */
  private drawn = false;

  /** The chip being named, or else the one chosen, slid into view, clear of the fading ends; wider than the row, its start. */
  private inView() {
    const row = this.chips;
    const on = this.here.naming?.isConnected ? this.here.naming : row.querySelector<HTMLElement>('[aria-checked="true"]');
    const fade = parseFloat(getComputedStyle(row).getPropertyValue('--fade')) || 0;
    if (on && row.scrollWidth > row.clientWidth) {
      const left = on.offsetLeft - fade, right = on.offsetLeft + on.offsetWidth + fade, at = row.scrollLeft;
      const to = left < at || right - left > row.clientWidth ? left : right > at + row.clientWidth ? right - row.clientWidth : at;
      if (to !== at) row.scrollTo({left: to, behavior: this.drawn && !still() ? 'smooth' : 'auto'});
    }
    if (on) this.drawn = true;
    this.ends();
  }

  /** The row's ends fade where there is more along it. */
  private ends() {
    const row = this.chips;
    row.classList.toggle('more-before', row.scrollLeft > 1);
    row.classList.toggle('more-after', row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
  }

  /** The boards one writes in as a guest, after one's servers: each alone, said to be a guest's. */
  private guesting(): HTMLElement[] {
    const ours = new Set(this.here.list.flatMap((s) => s.boards.map((b) => b.id)));
    return servers.guestBoards().filter(({id}) => !ours.has(id)).map(({id, here}) => {
      const b = h('button', {type: 'button', class: 'chip guest-chip', role: 'radio', 'aria-checked': String(id === this.here.alone),
        title: t('#{board} ({server}) · Guest', {board: here.name, server: here.server})}, `#${here.name}`, h('span', {class: 'muted small'}, t('Guest')));
      b.addEventListener('click', () => this.ways.showAlone({id, name: here.name, member: false, guests: true, server: here.server}));
      return b;
    });
  }

  /** The dots again, for what was heard. */
  mark() {
    for (const c of this.chips.querySelectorAll<HTMLElement>('.chip')) markChip(c, this.here.list);
  }

  /** Server `id`'s chip, if it is in the band. */
  chip(id: string): HTMLElement | null {
    return this.chips.querySelector<HTMLElement>(`[data-server="${CSS.escape(id)}"]`);
  }
}

/** A chip's dot, on while something came in its server not seen yet, and its name saying so. */
function markChip(chip: HTMLElement, list: servers.Server[]) {
  const on = serverNew(chip.dataset.server ?? '');
  chip.classList.toggle('news', on);
  const name = list.find((s) => s.id === chip.dataset.server)?.name ?? '';
  chip.setAttribute('aria-label', on ? t('{server} (new posts)', {server: name}) : name);
}
