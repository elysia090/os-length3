import {h} from '../../ui/dom.ts';
import {mark} from '../../ui/icons.ts';
import {t} from '../../../text/i18n.ts';
import {errorText} from '../../../api/errors.ts';
import * as servers from '../../../shipto/servers.ts';
import {serverNew} from '../../../shipto/news.ts';
import {current, type Here, type Shown} from './parts.ts';

/** The room already in hand, and the one action that opens the server index. */
interface BandWays {
  show(id: string): void;
  showAlone(b: Shown): void;
  make(): void;
  manage(): void;
  rename(id: string, name: string): Promise<void>;
  paperEdge(after: number): number | undefined;
}

type Choice = {key: string; label: string; checked?: boolean; act(): void; server?: string};
let nextPicker = 0;

export class Band {
  readonly element: HTMLElement;
  readonly key: HTMLButtonElement;
  private readonly held = h('div', {class: 'server-held', role: 'group'});
  private readonly name = h('button', {class: 'server-display-name', type: 'button'}) as HTMLButtonElement;
  private readonly label = h('span', {class: 'server-display-label'});
  private readonly editor = h('input', {class: 'server-display-edit', maxlength: '64', autocomplete: 'off', 'aria-label': t('Server name')}) as HTMLInputElement;
  private readonly renameError = h('span', {class: 'server-display-error', role: 'alert'});
  private readonly status = h('span', {class: 'muted server-room-status'});
  private readonly naming = h('div', {class: 'server-making-at'});
  private readonly panel: HTMLElement;
  private readonly chooser: HTMLElement;
  private readonly plus: HTMLButtonElement;
  private readonly said = h('div', {class: 'server-said'});
  private asked: HTMLElement | null = null;
  private listening: AbortController | null = null;
  private editing: {server: string; old: string; busy: boolean} | null = null;
  private readonly saving = new Set<string>();
  private readonly here: Here;
  private readonly ways: BandWays;

  constructor(here: Here, ways: BandWays) {
    this.here = here;
    this.ways = ways;
    const id = `server-choices-${++nextPicker}`;
    this.plus = h('button', {type: 'button', class: 'band-add', 'aria-label': t('Create server'), hidden: ''}, mark('plus')) as HTMLButtonElement;
    this.key = h('button', {type: 'button', class: 'server-disclosure', 'aria-label': t('Server menu'), 'aria-haspopup': 'menu',
      'aria-expanded': 'false', 'aria-controls': id}, h('span', {class: 'server-hinge', 'aria-hidden': 'true'}, mark('down'))) as HTMLButtonElement;
    this.held.append(this.name, this.label, this.editor, this.key);
    this.panel = h('div', {class: 'server-choices', id, role: 'menu', 'aria-label': t('Servers'), hidden: ''});
    this.chooser = h('div', {class: 'server-chooser', hidden: ''}, this.held, this.panel, this.renameError);
    this.element = h('div', {class: 'server-top'}, this.plus, h('div', {class: 'server-band-content'}, this.chooser, this.status, this.naming), this.said);

    this.plus.addEventListener('click', () => { this.close(); this.ways.make(); });
    this.key.addEventListener('click', () => { if (!this.close(true)) this.open(); });
    this.key.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      if (this.panel.hidden) this.open(e.key === 'ArrowUp');
    });
    this.panel.addEventListener('keydown', (e) => this.move(e));
    this.chooser.addEventListener('focusout', (e) => {
      if (e.relatedTarget instanceof Node && !this.chooser.contains(e.relatedTarget)) this.close();
    });
    this.name.addEventListener('click', () => this.beginName());
    this.name.addEventListener('keydown', (e) => { if (e.key === 'F2') { e.preventDefault(); this.beginName(); } });
    this.editor.addEventListener('input', () => { this.renameError.textContent = ''; });
    this.editor.addEventListener('keydown', (e) => {
      if (e.isComposing || !this.editing) return;
      if (e.key === 'Escape' && !this.editing.busy) { this.renameError.textContent = ''; this.endName(true); e.preventDefault(); }
      if (e.key === 'Enter') { e.preventDefault(); void this.finishName(true); }
    });
    this.editor.addEventListener('blur', () => {
      if (this.editing?.busy) this.endName();
      else void this.finishName(false);
    });
  }

  /** Under the band, while one is being made: what its Remote name can say no to. */
  asking(ask: HTMLElement) { this.asked = ask; }

  private guestChoices(): Choice[] {
    const ours = new Set(this.here.list.flatMap((s) => s.boards.map((b) => b.id)));
    return servers.guestBoards().filter(({id}) => !ours.has(id)).map(({id, here}) => ({
      key: `board:${id}`, label: `#${here.name} · ${t('Guest')}`, checked: id === this.here.alone,
      act: () => this.ways.showAlone({id, name: here.name, member: false, guests: true, server: here.server}),
    }));
  }

  private rows(): Choice[] {
    const room = current(this.here);
    const choices: Choice[] = this.here.list.map((s) => ({
      key: `server:${s.id}`, server: s.id, label: s.name, checked: s === room, act: () => this.ways.show(s.id),
    }));
    return [...choices, ...this.guestChoices(), ...(room ? [{key: 'manage', label: t('Manage…'), act: () => this.ways.manage()}] : [])];
  }

  private items() { return [...this.panel.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')]; }

  private paintChoices() {
    const focus = this.panel.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.choice : undefined;
    this.panel.replaceChildren(...this.rows().map((row) => {
      const b = h('button', {type: 'button', class: 'server-choice', 'data-choice': row.key, tabindex: '-1',
        ...(row.server ? {'data-server': row.server} : {}),
        ...(row.checked === undefined ? {role: 'menuitem'} : {role: 'menuitemradio', 'aria-checked': String(row.checked)})},
      h('span', {'aria-hidden': 'true', class: 'server-current-mark'}, row.checked ? '✓' : ''), h('span', {class: 'server-choice-name'}, row.label));
      b.addEventListener('click', () => { this.close(true); row.act(); });
      return b;
    }));
    if (focus) (this.items().find((b) => b.dataset.choice === focus) ?? this.items().find((b) => b.getAttribute('aria-checked') === 'true') ?? this.items()[0])?.focus({preventScroll: true});
  }

  private open(last = false) {
    if (this.chooser.hidden) return;
    this.paintChoices();
    const items = this.items();
    if (!items.length) return;
    this.fitChoices();
    this.panel.hidden = false;
    this.key.setAttribute('aria-expanded', 'true');
    const listening = this.listening = new AbortController();
    document.addEventListener('pointerdown', (e) => {
      if (!this.chooser.isConnected || !e.composedPath().includes(this.chooser)) this.close();
    }, {capture: true, signal: listening.signal});
    window.addEventListener('resize', () => this.fitChoices(), {signal: listening.signal});
    const first = last ? items.at(-1) : items.find((b) => b.getAttribute('aria-checked') === 'true') ?? items[0];
    first?.focus({preventScroll: true});
    this.mark();
  }

  /** On a desk with room beside the board, keep the chooser entirely in that left pocket.
   * A narrow viewport uses the same anchor, without resizing the paper to make a pocket. */
  private fitChoices() {
    const x = this.chooser.getBoundingClientRect().left;
    const unit = parseFloat(getComputedStyle(this.chooser).getPropertyValue('--u'));
    const beside = (this.ways.paperEdge(x) ?? x) - x - 4;
    const available = beside >= 4 * unit ? beside : window.innerWidth - x - 4;
    this.chooser.style.setProperty('--server-choices-fit', `${Math.max(0, Math.floor(available))}px`);
  }

  /** Close only the chooser, without moving or rebuilding the board. */
  close(restore = false): boolean {
    if (this.panel.hidden) return false;
    this.key.setAttribute('aria-expanded', 'false');
    this.panel.hidden = true;
    this.listening?.abort();
    this.listening = null;
    if (restore && !this.chooser.hidden) this.key.focus({preventScroll: true});
    return true;
  }

  private move(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); this.close(true); return; }
    if (e.key === 'Tab') { this.close(true); return; }
    const items = this.items(), at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 :
      e.key === 'ArrowDown' ? (at + 1) % items.length : e.key === 'ArrowUp' ? (at + items.length - 1) % items.length : -1;
    if (next < 0) return;
    e.preventDefault();
    items[next]?.focus({preventScroll: true});
  }

  /** The name is written at its own place, never an address or another settings sheet. */
  private beginName() {
    const s = current(this.here);
    if (!s?.owner || this.editing || this.saving.has(s.id)) return;
    this.close();
    this.fitChoices();
    this.editing = {server: s.id, old: s.name, busy: false};
    this.renameError.textContent = '';
    this.name.hidden = true;
    this.editor.hidden = false;
    this.editor.readOnly = false;
    this.editor.value = s.name;
    this.editor.focus({preventScroll: true});
    this.editor.select();
  }

  private endName(focus = false) {
    this.editing = null;
    this.editor.hidden = true;
    this.name.hidden = !current(this.here)?.owner;
    if (focus && !this.name.hidden) this.name.focus({preventScroll: true});
  }

  private async finishName(stay: boolean) {
    const edit = this.editing;
    if (!edit || edit.busy) return;
    const name = this.editor.value.trim();
    if (!name || edit.old === name) { this.endName(stay); return; }
    edit.busy = true;
    this.saving.add(edit.server);
    this.name.disabled = true;
    this.editor.readOnly = true;
    if (!stay) this.endName();
    try {
      await this.ways.rename(edit.server, name);
      this.saving.delete(edit.server);
      this.name.disabled = this.saving.has(this.here.serverId ?? '');
      if (this.editing === edit) this.endName(document.activeElement === this.editor);
    } catch (e) {
      this.saving.delete(edit.server);
      this.name.disabled = this.saving.has(this.here.serverId ?? '');
      if (current(this.here)?.id !== edit.server) return;
      if (this.editing === edit) { edit.busy = false; this.editor.readOnly = false; }
      this.renameError.textContent = errorText(e);
    }
  }

  /** The header remains the same node through list refresh, conversation scroll, and rename. */
  paint() {
    const {signedIn, serverId} = this.here;
    const room = current(this.here);
    const guests = this.guestChoices();
    const guest = this.here.alone ? guests.find((g) => g.checked) : undefined;
    if (this.editing && (this.editing.server !== serverId || !room?.owner)) this.endName();
    this.plus.hidden = !signedIn;
    this.status.hidden = signedIn;
    this.status.textContent = signedIn ? '' : t('Public boards');
    this.said.replaceChildren(...(this.here.naming && this.asked ? [this.asked] : []));
    const naming = this.here.naming;
    const typing = naming?.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    if (this.naming.firstElementChild !== naming) this.naming.replaceChildren(...(naming ? [naming] : []));
    typing?.focus({preventScroll: true});
    this.naming.hidden = !naming;
    this.chooser.hidden = !signedIn || !!naming || !(this.here.list.length || guests.length);
    if (this.chooser.hidden) this.close();
    const was = this.held.dataset.server;
    if (was !== (room?.id || undefined)) this.renameError.textContent = '';
    if (room) { this.held.dataset.server = room.id; this.held.setAttribute('aria-current', 'true'); }
    else { delete this.held.dataset.server; this.held.removeAttribute('aria-current'); }
    const name = room?.name ?? guest?.label ?? t('Servers');
    this.name.textContent = name;
    this.name.setAttribute('aria-label', t('Rename {name}', {name}));
    this.label.textContent = name;
    this.label.hidden = !!room?.owner;
    this.name.hidden = !room?.owner || !!this.editing;
    this.name.disabled = this.saving.has(serverId ?? '');
    this.editor.hidden = !this.editing;
    if (!this.panel.hidden) this.paintChoices();
    this.mark();
  }

  /** Unseen posts mark the room, also when the list is closed. */
  mark() {
    const room = current(this.here);
    const on = !!room && serverNew(room.id);
    this.held.classList.toggle('news', on);
    const name = room?.name ?? this.label.textContent ?? '';
    this.held.setAttribute('aria-label', on ? t('{server} (new posts)', {server: name}) : name);
    for (const el of this.panel.querySelectorAll<HTMLElement>('[data-server]')) {
      const s = this.here.list.find((item) => item.id === el.dataset.server);
      if (!s) continue;
      const unseen = serverNew(s.id);
      el.classList.toggle('news', unseen);
      el.setAttribute('aria-label', unseen ? t('{server} (new posts)', {server: s.name}) : s.name);
    }
  }

  chip(id: string): HTMLElement | null { return this.held.dataset.server === id ? this.held : null; }
}
