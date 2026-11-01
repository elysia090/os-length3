import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {connection, onConnection} from '../../remote/connection.ts';
import {lastServers, servers, type Server} from '../../remote/servers.ts';
import {news, onNews} from '../../remote/news.ts';
import type {Context} from '../context.ts';
import {remember, remembered} from './parts.ts';

// Server, glanced at: a rest on its icon brings out one's servers beside the rail, as File's tree comes out of File,
// a row a server (its mark, its name, a dot while something in it is not read), to jump to: pressed, the Server page
// at that server. A press on the icon itself goes to the Server page where one was. It is a way to a server, never
// the server laid over the page: what is done in one is done on its page.

/** A server's mark: the first letter of each of its first two words (Trip T, Book club BC), as a server's is told at a glance. */
const initialsOf = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((w) => Array.from(w)[0] ?? '').join('').toUpperCase();

/** How long the pointer rests on Server before its servers come out: passing over the rail brings nothing out. */
const OPEN_DELAY = 300;
/** How long they stay once the pointer has gone: brushed past on the icon, a moment; gone from the card, a little longer. */
const LINGER_PASSED = 450, LINGER = 1200;

export class ServerSwitcher {
  readonly element = h('nav', {class: 'server-switch', id: 'server-switch', 'aria-label': t('Servers')});
  private readonly ctx: Context;
  private trigger: HTMLElement | null = null;
  private timer = 0;
  /** The pointer went into the card: a reach back to it finds it. */
  private visited = false;
  /** Its rows were last drawn for this list (and these marks): drawn again only when they change. */
  private drawnFor = '';

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.element.addEventListener('pointerenter', () => { this.visited = true; clearTimeout(this.timer); });
    this.element.addEventListener('pointerleave', () => this.later(false, LINGER));
    this.element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); this.close(); this.trigger?.focus(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const rows = [...this.element.querySelectorAll<HTMLElement>('.server-switch-row')];
      const i = rows.indexOf(document.activeElement as HTMLElement);
      if (i < 0) return;
      event.preventDefault();
      rows[(i + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
    });
    document.addEventListener('pointerdown', (event) => {
      if (this.isOpen && !this.element.contains(event.target as Node) && !this.trigger?.contains(event.target as Node)) this.close();
    });
    onNews(() => { if (this.isOpen) this.draw(lastServers() ?? []); });
    onConnection(() => { if (this.isOpen) void this.read(); });
  }

  get isOpen() { return this.element.classList.contains('out'); }

  /** The rail's Server button: a rest brings the servers out; a press goes to the page. */
  attach(button: HTMLElement) {
    this.trigger = button;
    button.setAttribute('aria-controls', 'server-switch');
    document.body.append(this.element);
    button.addEventListener('pointerenter', () => { this.visited = false; this.later(true, this.isOpen ? 0 : OPEN_DELAY); });
    button.addEventListener('pointerleave', () => this.later(false, this.visited ? LINGER : LINGER_PASSED));
    button.addEventListener('click', () => { this.close(); void this.ctx.go('server'); });
    // From the keyboard, ↓ on the icon brings them out and goes into them, as → goes into File's tree.
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight') return;
      event.preventDefault();
      this.open();
      requestAnimationFrame(() => this.element.querySelector<HTMLElement>('.server-switch-row')?.focus());
    });
  }

  /** The pointer on another place on the rail: what a rest brought out goes. */
  passedBy() { if (this.isOpen) this.close(); }

  private later(open: boolean, after: number) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => (open ? this.open() : this.close()), after);
  }

  /** Out beside the rail, level with Server's icon, drawn at once from the list last given and read afresh. */
  open() {
    clearTimeout(this.timer);
    if (this.isOpen) return;
    const icon = this.trigger?.getBoundingClientRect();
    if (icon) this.element.style.setProperty('--switch-top', `${Math.max(8, icon.top - 8)}px`);
    this.drawnFor = '';
    this.draw(lastServers() ?? []);
    this.element.classList.add('out');
    this.trigger?.setAttribute('aria-expanded', 'true');
    void this.read();
  }

  close() {
    clearTimeout(this.timer);
    if (!this.isOpen) return;
    this.element.classList.remove('out');
    this.trigger?.setAttribute('aria-expanded', 'false');
  }

  private async read() {
    const list = connection() ? await servers().catch(() => null) : [];
    if (list && this.isOpen) this.draw(list);
  }

  /** A row a server, newest-word first only as one ordered them: the order of their chips on the page. */
  private draw(list: Server[]) {
    const fresh = new Set(news().boards.map((b) => b.server));
    const key = JSON.stringify([connection() ? 'in' : 'out', list.map((s) => [s.id, s.name, fresh.has(s.id)])]);
    if (key === this.drawnFor) return;
    this.drawnFor = key;
    const rows = list.map((s) => {
      const row = h('button', {type: 'button', class: 'server-switch-row', 'aria-label': fresh.has(s.id) ? t('{name} (new posts)', {name: s.name}) : s.name},
        h('span', {class: 'server-switch-mark', 'aria-hidden': 'true'}, initialsOf(s.name)),
        h('span', {class: 'server-switch-name'}, s.name),
        fresh.has(s.id) ? h('span', {class: 'server-switch-dot', 'aria-hidden': 'true'}) : null);
      row.addEventListener('click', () => this.go({server: s.id}));
      return row;
    });
    const make = h('button', {type: 'button', class: 'server-switch-row server-switch-make'},
      h('span', {class: 'server-switch-mark', 'aria-hidden': 'true'}, '+'), h('span', {class: 'server-switch-name'}, t('Create server')));
    make.addEventListener('click', () => this.go({making: true}));
    const out = !connection();
    this.element.replaceChildren(...(out
      ? [h('p', {class: 'muted small server-switch-none'}, t('Sign in to create servers with discussion boards for your team.'))]
      : [...rows, make]));
  }

  /** To the Server page, at `at` (a server, or making one), the card put away. */
  private go(at: {server?: string; making?: boolean}) {
    remember(at.making ? {...remembered(), making: true} : {server: at.server});
    this.close();
    void this.ctx.go('server');
  }
}
