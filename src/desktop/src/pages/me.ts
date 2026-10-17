import {h} from '../dom.ts';
import {currentLang, LANGS, setLang, t} from '../i18n.ts';
import {icon, mark} from '../icons.ts';
import {connection, signOut} from '../remote.ts';
import {setState} from '../state.ts';
import {initials, type Profile} from '../profile.ts';
import {purpose} from '../purposes.ts';
import {choosePart, reveal} from './common.ts';
import type {Context} from './context.ts';

/** The pages a setting opens. */
type Page = 'home' | 'remote' | 'runtime';

// The person's own icon at the foot of the rail: their initials, or a head
// and shoulders before there is a name. Touching it brings out the way into
// every setting, in groups (the profile, the account, this device, the
// language), each saying the page where it lives, since a setting is kept
// with what it is about rather than on a page of its own. Signing out is
// here too, at the foot of the rail. The language shows the one in use;
// pressed, it opens into the list. It goes away
// when the pointer leaves, on a press outside, or on Escape.

const OPEN_DELAY = 80;
const CLOSE_DELAY = 400;

export class Me {
  readonly element: HTMLElement;
  private button: HTMLButtonElement;
  private pop: HTMLElement;
  private timer = 0;
  private ctx: Context;
  private profile: () => Profile;
  /** The language list is open, in place of the language in use. */
  private choosing = false;

  constructor(ctx: Context, profile: () => Profile, actions: {editProfile(): void}) {
    this.ctx = ctx;
    this.profile = profile;
    this.button = h('button', {type: 'button', class: 'me', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'me-pop'}) as HTMLButtonElement;
    // `page`: where it opens, shown by that page's own icon (named in its title). `checked`: one of a choice (the language), on or off.
    const item = (label: string, run: (() => void) | null, page?: Page, checked?: boolean) => {
      const at = page ? icon(page) : null;
      at?.classList.add('me-where');
      const b = h('button', {type: 'button', class: 'me-item', role: checked === undefined ? 'menuitem' : 'menuitemradio'}, label, at);
      if (page) b.title = t(purpose(page).label);
      if (checked !== undefined) b.setAttribute('aria-checked', String(checked));
      if (run) b.addEventListener('click', () => { this.close(); run(); }); else b.setAttribute('disabled', '');
      return b;
    };
    const group = (title: string, ...items: HTMLElement[]) =>
      h('div', {class: 'me-group', role: 'group', 'aria-label': title}, h('div', {class: 'me-head muted small'}, title), ...items);
    // A part of a page, or a section of one, brought into view.
    const to = (page: Page, part?: string, section?: string) => () => {
      if (part) choosePart(page, part);
      this.ctx.go(page);
      if (section) reveal(section);
    };
    this.pop = h('div', {class: 'me-pop', id: 'me-pop', role: 'menu', 'aria-label': t('Me')});
    const fill = () => {
      const p = this.profile();
      const signedIn = connection() !== null;
      this.pop.replaceChildren(
        h('div', {class: 'me-who'}, this.face(), h('div', {class: 'me-name'},
          h('b', {}, p.name || (p.handle ? `@${p.handle}` : t('No name yet'))),
          p.name && p.handle ? h('span', {class: 'muted small'}, `@${p.handle}`) : null)),
        // Each a word or two: the group says what it is about.
        group(t('Profile'),
          item(t('View'), to('home'), 'home'),
          item(t('Edit'), () => actions.editProfile(), 'home')),
        group(t('Account'), ...(signedIn
          ? [item(t('Sign-in'), to('remote', 'sign-in'), 'remote'), item(t('Devices'), to('remote', 'devices'), 'remote'), item(t('Sign out'), () => void signOut())]
          : [item(t('Sign in'), to('remote'), 'remote')])),
        group(t('This device'),
          item(t('Room'), to('runtime'), 'runtime'),
          item(t('Environment'), to('runtime', undefined, 'env-title'), 'runtime')),
        // The language is Home's setting, so l3 speaks the same one.
        group(t('Language'), ...(this.choosing
          ? LANGS.map((l) => item(l.name, () => { this.choosing = false; setLang(l.id); void setState('lang', JSON.stringify(l.id)); }, undefined, l.id === currentLang()))
          : [now()])));
    };
    /** The language in use; pressed, the list in its place, the menu staying out. */
    const now = () => {
      const b = h('button', {type: 'button', class: 'me-item', role: 'menuitem', 'aria-haspopup': 'true', 'aria-expanded': 'false'},
        LANGS.find((l) => l.id === currentLang())?.name ?? '', mark('down'));
      b.querySelector('svg')?.classList.add('me-where');
      b.addEventListener('click', () => {
        this.choosing = true;
        fill();
        this.pop.querySelector<HTMLElement>('.me-item[aria-checked="true"]')?.focus();
      });
      return b;
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

  /** The person's initials, or a head and shoulders before there is a name. */
  private face(): Node {
    const text = initials(this.profile());
    return text ? h('span', {class: 'me-initials'}, text) : mark('person');
  }

  /** Redraw the icon from the profile. */
  paint() {
    this.button.replaceChildren(this.face());
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
    this.choosing = false;
    this.element.classList.remove('open');
    this.button.setAttribute('aria-expanded', 'false');
  }
}
