import {h} from '../ui/dom.ts';
import {currentLang, LANGS, setLang, t} from '../i18n.ts';
import {mark} from '../ui/icons.ts';
import {connection, myName, signOut} from '../remote/connection.ts';
import {onState, setState} from '../home/state.ts';
import {initials, type Profile} from '../home/profile.ts';
import {choosePart} from './common.ts';
import type {Context} from './context.ts';

/** The person's name as written on Home; none written there, the one signed in with (the Remote's), as Home says it. */
function shownName(written: string): HTMLElement {
  const b = h('b', {}, written || t('No name yet'));
  if (!written) void myName().then((n) => { if (n) b.textContent = n; }, () => {});
  return b;
}

/** The pages a setting opens. */
type Page = 'home' | 'remote';

// The person's own icon at the foot of the rail: their initials, or a head
// and shoulders before there is a name. Touching it brings out what is the
// person's own, in groups (the profile, the account, the language), and
// nothing else: the places of the OS are the rail's, so the menu does not
// name them again. Signing out is here too, at the foot of the rail. The
// language shows the one in use;
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
    // `checked`: one of a choice (the language), on or off.
    const item = (label: string, run: (() => void) | null, checked?: boolean) => {
      const b = h('button', {type: 'button', class: 'pop-item', role: checked === undefined ? 'menuitem' : 'menuitemradio'}, label);
      if (checked !== undefined) b.setAttribute('aria-checked', String(checked));
      // The menu goes, and the keyboard back to the face it came from, unless what was chosen takes it on (a field to write in).
      if (run) b.addEventListener('click', () => { this.close(); this.button.focus(); run(); }); else b.setAttribute('disabled', '');
      return b;
    };
    const group = (title: string, ...items: HTMLElement[]) =>
      h('div', {class: 'pop-group', role: 'group', 'aria-label': title}, h('div', {class: 'pop-head muted small'}, title), ...items);
    // A part of a page brought into view.
    const to = (page: Page, part?: string) => () => {
      if (part) choosePart(page, part);
      this.ctx.go(page);
    };
    this.pop = h('div', {class: 'me-pop pop', id: 'me-pop', role: 'menu', 'aria-label': t('Me')});
    const fill = () => {
      const p = this.profile();
      const signedIn = connection() !== null;
      this.pop.replaceChildren(
        h('div', {class: 'me-who'}, this.face(), h('div', {class: 'me-name'},
          shownName(p.name || (p.handle ? `@${p.handle}` : '')),
          p.name && p.handle ? h('span', {class: 'muted small'}, `@${p.handle}`) : null)),
        // Each a word or two: the group says what it is about. The profile is read on Home, from the rail.
        group(t('Profile'),
          item(t('Edit profile'), () => actions.editProfile())),
        group(t('Account'), ...(signedIn
          ? [item(t('Sign-in'), to('remote', 'sign-in')), item(t('Devices'), to('remote', 'devices')), item(t('Sign out'), () => void signOut())]
          : [item(t('Sign in'), to('remote'))])),
        // The language is Home's setting, so l3 speaks the same one.
        group(t('Language'), ...(this.choosing
          ? LANGS.map((l) => item(l.name, () => { this.choosing = false; setLang(l.id); void setState('lang', JSON.stringify(l.id)); }, l.id === currentLang()))
          : [now()])));
    };
    /** The language in use; pressed, the list in its place, the menu staying out. */
    const now = () => {
      const b = h('button', {type: 'button', class: 'pop-item', role: 'menuitem', 'aria-haspopup': 'true', 'aria-expanded': 'false'},
        LANGS.find((l) => l.id === currentLang())?.name ?? '', mark('down'));
      b.querySelector('svg')?.classList.add('pop-mark');
      b.addEventListener('click', () => {
        this.choosing = true;
        fill();
        this.pop.querySelector<HTMLElement>('.pop-item[aria-checked="true"]')?.focus();
      });
      return b;
    };
    this.element = h('div', {class: 'me-wrap'}, this.button, this.pop);
    this.paint();
    // The profile saved (on Home, or from another device): the face on the rail is the new one at once.
    onState((key) => { if (key === 'profile') this.paint(); });
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
      const items = [...this.pop.querySelectorAll<HTMLElement>('.pop-item:not([disabled])')];
      if (!items.length) return;
      event.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!this.element.contains(event.target as Node)) this.close();
    });
    // Tab out of it puts it away, as a press outside does (a row redrawn in place has no next focus, and keeps it out).
    this.element.addEventListener('focusout', (event) => {
      const to = event.relatedTarget as Node | null;
      if (to && !this.element.contains(to)) this.close();
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
    this.pop.setAttribute('aria-label', t('Me'));
  }

  private later(open: boolean, after: number) {
    clearTimeout(this.timer);
    // Out already, it is left as it is: drawn again under the pointer, the row being pressed would be another by the
    // time the press ends (the language chosen from its list never taking).
    this.timer = window.setTimeout(() => { if (open) { if (!this.isOpen) this.fill(); this.open(false); } else this.close(); }, after);
  }

  private open(focus: boolean) {
    clearTimeout(this.timer);
    this.element.classList.add('open');
    this.button.setAttribute('aria-expanded', 'true');
    if (focus) this.pop.querySelector<HTMLElement>('.pop-item')?.focus();
  }

  close() {
    clearTimeout(this.timer);
    this.choosing = false;
    this.element.classList.remove('open');
    this.button.setAttribute('aria-expanded', 'false');
  }
}
