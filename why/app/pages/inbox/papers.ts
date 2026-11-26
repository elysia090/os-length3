import {Drafts} from '../../../home/drafts.ts';
import {t} from '../../../text/i18n.ts';
import {h} from '../../ui/dom.ts';

/** An address is never empty or contains a NUL, including when entered by its six-digit code. */
export const recipientPaper = '\0recipient';

/** The opened papers, in the order they were picked up; last letter and separately kept writing. */
export class InboxPapers {
  readonly opened = new Set<string>();
  readonly drafts = new Drafts();
  private pending = new Set<string>();
  private watch = new Map<string, () => void>();
  readonly scroll = new Map<string, number>();
  to = '';
  active: string | null = null;
  private lastLetter: string | null = null;

  busy(key: string) { return this.pending.has(key); }

  wait(key: string, yes: boolean) {
    if (yes) this.pending.add(key); else this.pending.delete(key);
    this.watch.get(key)?.();
  }

  watching(key: string, update: () => void) {
    this.watch.set(key, update);
    return () => { if (this.watch.get(key) === update) this.watch.delete(key); };
  }

  take(key: string) {
    this.opened.add(key);
    this.active = key;
    if (key !== recipientPaper) this.lastLetter = key;
  }

  closeRecipient() {
    this.opened.delete(recipientPaper);
    if (this.active === recipientPaper) this.active = this.lastLetter;
  }

  block(address: string) {
    this.opened.delete(address);
    this.drafts.sent(address);
    this.scroll.delete(address);
    if (this.lastLetter === address) this.lastLetter = [...this.opened].reverse().find((x) => x !== recipientPaper) ?? null;
    if (this.active === address) this.active = this.lastLetter;
  }
}

/** The same one-mark-per-paper switch as Forge. A key in the index alone is never a mark here. */
export function paperSwitch(papers: InboxPapers, label: (key: string) => string, take: (key: string) => void) {
  const element = h('div', {class: 'row-map inbox-paper-map', role: 'group', 'aria-label': t('Open Inbox papers'), hidden: ''});
  const keys = new Map<string, HTMLButtonElement>();
  const paint = () => {
    for (const [key, button] of keys) if (!papers.opened.has(key)) { button.remove(); keys.delete(key); }
    // The changed-address paper always lies after the letters, even if you pick up another while writing it.
    const ordered = [...papers.opened].filter((key) => key !== recipientPaper);
    if (papers.opened.has(recipientPaper)) ordered.push(recipientPaper);
    ordered.forEach((key, at) => {
      let button = keys.get(key);
      if (!button) {
        button = h('button', {type: 'button', class: 'row-piece'}) as HTMLButtonElement;
        button.addEventListener('click', () => take(key));
        keys.set(key, button);
      }
      if (element.children[at] !== button) element.insertBefore(button, element.children[at] ?? null);
      const current = key === papers.active;
      button.setAttribute('aria-label', label(key));
      button.setAttribute('aria-current', String(current));
      button.tabIndex = current ? 0 : -1;
    });
    element.style.setProperty('--paper-count', String(keys.size));
    element.hidden = keys.size < 2;
  };
  element.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (!step || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const buttons = [...element.children] as HTMLButtonElement[], at = buttons.indexOf(e.target as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    buttons[(at + step + buttons.length) % buttons.length].focus({preventScroll: true});
  });
  return {element, paint};
}
