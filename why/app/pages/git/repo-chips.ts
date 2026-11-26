import {h} from '../../ui/dom.ts';
import {t} from '../../../text/i18n.ts';

let picked = 0;

/** The repo name over main, and only when there is a choice, its list of known folders outside the issue. */
export class RepoFolders {
  private readonly id = `git-folders-${++picked}`;
  private readonly plain = h('span', {class: 'git-repo-name'});
  private readonly key = h('button', {class: 'git-repo-key', type: 'button', 'aria-haspopup': 'menu',
    'aria-expanded': 'false', 'aria-controls': this.id, hidden: ''}) as HTMLButtonElement;
  private readonly menu = h('div', {class: 'git-repo-menu', id: this.id, role: 'menu', 'aria-label': t('Git folders'), hidden: ''});
  private readonly status = h('span', {class: 'git-repo-status', role: 'status', hidden: ''});
  readonly element = h('div', {class: 'git-repo-picker', hidden: ''}, this.plain, this.key, this.menu, this.status);
  private names: readonly string[] = [];
  private repo: string | null = null;
  private origin: HTMLElement | null = null;
  private pointerOrigin: HTMLElement | null = null;
  private listening: AbortController | null = null;
  private removal: MutationObserver | null = null;
  private exit = 0;
  private readonly choose: (repo: string, origin: HTMLElement | null) => void;

  constructor(choose: (repo: string, origin: HTMLElement | null) => void) {
    this.choose = choose;
    this.key.addEventListener('pointerdown', () => { this.pointerOrigin = this.focused(); });
    this.key.addEventListener('click', (event) => {
      const from = event.detail ? this.pointerOrigin : this.focused();
      this.pointerOrigin = null;
      if (this.menu.hidden) this.open(from, event.detail > 0);
      else this.close(true);
    });
    this.key.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      this.open(this.key);
    });
    this.menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(true); return; }
      clearTimeout(this.exit);
      // Let Tab leave by the same keyboard route it arrived on.
      if (event.key === 'Tab') { this.close(false); this.focus(); return; }
      const all = this.buttons;
      const at = all.indexOf(document.activeElement as HTMLButtonElement);
      const count = all.length;
      if (!count) return;
      const next = event.key === 'ArrowDown' ? (at + 1) % count : event.key === 'ArrowUp' ? (at - 1 + count) % count :
        event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      this.take(all[next]!);
    });
  }

  /** Update the name only when the Git desk actually changes. An in-flight read never relabels the old issue. */
  show(names: readonly string[], repo: string | null) {
    if (this.repo === repo && names.length === this.names.length && names.every((name, k) => this.names[k] === name)) return;
    const active = this.focused() === this.key;
    this.close(true);
    this.names = names.slice();
    this.repo = repo;
    this.element.hidden = !repo;
    this.key.hidden = !repo || names.length < 2;
    this.plain.hidden = !this.key.hidden;
    this.plain.textContent = repo ? `${repo}/` : '';
    this.key.textContent = this.plain.textContent;
    this.key.setAttribute('aria-label', t('Git folder: {name}', {name: repo ?? ''}));
    if (active && this.key.hidden) this.element.closest<HTMLElement>('.git-desk')?.focus({preventScroll: true});
  }

  say(message = '') {
    this.status.textContent = message;
    this.status.hidden = !message;
  }

  /** Never scroll the issue or steal its keyboard on a late reply. */
  focus() { if (!this.key.hidden && this.key.isConnected) this.key.focus({preventScroll: true}); }

  owns(element: HTMLElement | null) { return element !== null && this.element.contains(element); }

  private focused() { return document.activeElement instanceof HTMLElement ? document.activeElement : null; }
  private get buttons() { return [...this.menu.querySelectorAll<HTMLButtonElement>('button[role=menuitemradio]')]; }

  private open(origin: HTMLElement | null, mouse = false) {
    if (!this.repo || this.names.length < 2 || !this.menu.hidden) return;
    this.origin = origin;
    this.menu.replaceChildren(...this.names.map((name) => {
      const row = h('button', {type: 'button', class: 'git-repo-option', role: 'menuitemradio', tabindex: '-1',
        'aria-label': name, 'aria-checked': String(name === this.repo)},
        h('span', {class: 'git-repo-tick', 'aria-hidden': 'true'}, name === this.repo ? '✓' : ''),
        h('span', {class: 'git-repo-option-name'}, `${name}/`)) as HTMLButtonElement;
      row.addEventListener('click', () => {
        if (name === this.repo) { this.close(true); return; }
        const from = this.origin;
        this.close(false);
        this.focus();
        this.choose(name, from);
      });
      return row;
    }));
    this.menu.hidden = false;
    this.key.setAttribute('aria-expanded', 'true');
    this.position();
    const selected = this.buttons.find(b => b.getAttribute('aria-checked') === 'true') ?? this.buttons[0];
    if (selected) this.take(selected);
    const listening = this.listening = new AbortController();
    const {signal} = listening;
    document.addEventListener('pointerdown', (e) => {
      if (e.target instanceof Node && !this.element.contains(e.target)) this.close(false);
    }, {capture: true, signal});
    document.addEventListener('focusin', (e) => {
      if (e.target instanceof Node && !this.element.contains(e.target)) this.close(false);
    }, {signal});
    window.addEventListener('resize', () => this.position(), {signal});
    if (mouse) {
      // Leave enough time to cross the small gap from the key to its menu.
      this.element.addEventListener('pointerleave', e => {
        if (e.pointerType === 'mouse') this.exit = window.setTimeout(() => this.close(true), 120);
      }, {signal});
      this.element.addEventListener('pointerenter', () => clearTimeout(this.exit), {signal});
    }
    // The shell replaces page contents. An open list must not keep document listeners after leaving Git.
    this.removal = new MutationObserver(() => { if (!this.element.isConnected) this.close(false); });
    this.removal.observe(document.body, {childList: true, subtree: true});
  }

  private close(restore: boolean) {
    if (this.menu.hidden) return;
    const from = this.origin;
    this.origin = null;
    this.menu.hidden = true;
    this.key.setAttribute('aria-expanded', 'false');
    clearTimeout(this.exit);
    this.listening?.abort();
    this.listening = null;
    this.removal?.disconnect();
    this.removal = null;
    this.menu.replaceChildren();
    if (!restore) return;
    if (from?.isConnected && from !== document.body) from.focus({preventScroll: true});
    else this.focus();
  }

  private position() {
    if (this.menu.hidden) return;
    const key = this.key.getBoundingClientRect();
    const side = this.element.closest<HTMLElement>('.git-side')?.getBoundingClientRect();
    const field = this.element.closest<HTMLElement>('.git-desk')?.querySelector<HTMLElement>('.git-issues')?.getBoundingClientRect();
    // To the right of a short name if the issue doesn't begin there; otherwise below the same name, over main only.
    const right = field && side && field.left >= side.right ? field.left : (side?.right ?? innerWidth);
    const span = this.menu.offsetWidth;
    const beside = key.right + 6 + span <= Math.min(right - 6, innerWidth);
    const x = Math.max(6, Math.min(beside ? key.right + 6 : key.left, innerWidth - span - 6));
    this.menu.style.left = `${x - key.left}px`;
    this.menu.style.top = beside ? '-6px' : `${this.key.offsetHeight}px`;
  }

  private take(row: HTMLButtonElement) {
    row.focus({preventScroll: true});
    const top = row.offsetTop, bottom = top + row.offsetHeight;
    if (top < this.menu.scrollTop) this.menu.scrollTop = top;
    else if (bottom > this.menu.scrollTop + this.menu.clientHeight) this.menu.scrollTop = bottom - this.menu.clientHeight;
  }
}
