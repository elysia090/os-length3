import {h} from '../dom.ts';
import {currentLang, LANGS, setLang, t} from '../i18n.ts';
import {setState} from '../state.ts';
import {initials, type Profile} from '../profile.ts';
import type {Context} from './context.ts';

// The person's own icon at the foot of the rail. Touching it brings out the
// few things one does before going into settings: see or edit the profile,
// look at this device, choose the language. It goes away when the pointer leaves, on a press
// outside, or on Escape.

const OPEN_DELAY = 80;
const CLOSE_DELAY = 400;

export class Me {
  readonly element: HTMLElement;
  private button: HTMLButtonElement;
  private pop: HTMLElement;
  private timer = 0;
  private ctx: Context;
  private profile: () => Profile;

  constructor(ctx: Context, profile: () => Profile, actions: {editProfile(): void}) {
    this.ctx = ctx;
    this.profile = profile;
    this.button = h('button', {type: 'button', class: 'me', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'me-pop'}) as HTMLButtonElement;
    const item = (label: string, run: (() => void) | null, note?: string, current = false) => {
      const b = h('button', {type: 'button', class: 'me-item', role: current ? 'menuitemradio' : 'menuitem'}, label, note ? h('span', {class: 'muted small'}, note) : null);
      if (current) b.setAttribute('aria-checked', 'true');
      if (run) b.addEventListener('click', () => { this.close(); run(); }); else b.setAttribute('disabled', '');
      return b;
    };
    this.pop = h('div', {class: 'me-pop', id: 'me-pop', role: 'menu', 'aria-label': t('Me')});
    const fill = () => {
      const p = this.profile();
      this.pop.replaceChildren(
        h('div', {class: 'me-who'}, h('b', {}, p.name || (p.handle ? `@${p.handle}` : t('No name yet'))),
          p.name && p.handle ? h('span', {class: 'muted small'}, `@${p.handle}`) : null),
        item(t('See profile'), () => this.ctx.go('home')),
        item(t('Edit profile'), () => actions.editProfile()),
        item(t('Room on this device'), () => this.ctx.go('runtime')),
        // The language is Home's setting, so l3 speaks the same one.
        h('div', {class: 'me-head muted small'}, t('Language')),
        ...LANGS.map((l) => item(l.name, () => { setLang(l.id); void setState('lang', JSON.stringify(l.id)); }, undefined, l.id === currentLang())));
    };
    this.element = h('div', {class: 'me-wrap'}, this.button, this.pop);
    this.paint();
    this.element.addEventListener('pointerenter', () => this.later(true, OPEN_DELAY));
    this.element.addEventListener('pointerleave', () => this.later(false, CLOSE_DELAY));
    this.button.addEventListener('click', (event) => {
      if (this.isOpen && event.detail === 0) { this.close(); return; }
      fill();
      this.open(event.detail === 0);
    });
    this.element.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { this.close(); this.button.focus(); return; }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const items = [...this.pop.querySelectorAll<HTMLElement>('.me-item:not([disabled])')];
      if (!items.length) return;
      event.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!this.element.contains(event.target as Node)) this.close();
    });
    this.fill = fill;
  }

  private fill: () => void;

  get isOpen() { return this.element.classList.contains('open'); }

  /** Redraw the icon from the profile (initials, or a plain head when none). */
  paint() {
    const text = initials(this.profile());
    this.button.replaceChildren(text || '?');
    this.button.setAttribute('aria-label', t('Me'));
  }

  private later(open: boolean, after: number) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => { if (open) { this.fill(); this.open(false); } else this.close(); }, after);
  }

  private open(focus: boolean) {
    clearTimeout(this.timer);
    this.element.classList.add('open');
    this.button.setAttribute('aria-expanded', 'true');
    if (focus) this.pop.querySelector<HTMLElement>('.me-item')?.focus();
  }

  close() {
    clearTimeout(this.timer);
    this.element.classList.remove('open');
    this.button.setAttribute('aria-expanded', 'false');
  }
}
