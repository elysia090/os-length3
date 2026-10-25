import {h} from '../../ui/dom.ts';
import {mark} from '../../ui/icons.ts';
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

/** What the band's presses do. */
export interface BandWays {
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
  /** The gear, at the top line's right end (in the layer's bar, beside the side). */
  readonly gear: HTMLButtonElement;
  private readonly chips: HTMLElement;
  private readonly plus: HTMLButtonElement;
  private readonly here: Here;
  private readonly ways: BandWays;

  constructor(here: Here, ways: BandWays) {
    this.here = here;
    this.ways = ways;
    this.chips = h('div', {class: 'chips server-chips', role: 'radiogroup', 'aria-label': 'Server'});
    this.gear = h('button', {type: 'button', class: 'server-gear unseen', 'aria-label': t('Its people, boards and repos'), title: t('Its people, boards and repos'), 'aria-expanded': 'false', disabled: ''}, mark('gear')) as HTMLButtonElement;
    this.plus = h('button', {type: 'button', class: 'band-add', 'aria-label': t('Make a server'), title: t('Make a server'), hidden: ''}, mark('plus')) as HTMLButtonElement;
    this.plus.addEventListener('click', () => ways.make());
    this.gear.addEventListener('click', () => ways.gear());
    this.element = h('div', {class: 'server-top'}, this.plus, this.chips);
  }

  /** Drawn again for what is chosen now. Signed out there are no servers of one's own: the band says what is shown. */
  paint() {
    const {serverId, signedIn} = this.here;
    this.gear.disabled = !serverId;
    this.gear.classList.toggle('unseen', !serverId);
    this.plus.hidden = !signedIn;
    if (!signedIn) { this.chips.replaceChildren(h('span', {class: 'muted'}, t('Open boards'))); return; }
    const each = this.here.list.map((s) => {
      const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(s.id === serverId), title: `${named(s.address)} · ${s.code}`, 'data-server': s.id}, s.name);
      markChip(b, this.here.list);
      b.addEventListener('click', () => this.ways.show(s.id));
      return b;
    });
    this.chips.replaceChildren(...each, ...(this.here.naming ? [this.here.naming] : []), ...this.guesting());
  }

  /** The boards one writes in as a guest, after one's servers: each alone, said to be a guest's. */
  private guesting(): HTMLElement[] {
    const ours = new Set(this.here.list.flatMap((s) => s.boards.map((b) => b.id)));
    return servers.guestBoards().filter(({id}) => !ours.has(id)).map(({id, here}) => {
      const b = h('button', {type: 'button', class: 'chip guest-chip', role: 'radio', 'aria-checked': String(id === this.here.alone),
        title: t('#{board} of {server}, as a guest', {board: here.name, server: here.server})}, `#${here.name}`, h('span', {class: 'muted small'}, t('guest')));
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
  chip.setAttribute('aria-label', on ? t('{server}, new posts', {server: name}) : name);
}
