import {boardNew} from '../../../shipto/news.ts';
import {t} from '../../../text/i18n.ts';
import {h} from '../../ui/dom.ts';
import type {Shown} from './parts.ts';

/** Stable keys: an unread arrival must not replace what has the keyboard. */
export class TopicIndex {
  readonly element = h('nav', {class: 'server-index', 'aria-label': t('Topics')});
  private readonly list = h('ul', {class: 'server-topics'});
  private readonly newThread = h('button', {type: 'button', class: 'topic-key topic-new'}, t('New thread…')) as HTMLButtonElement;
  private rows = new Map<string, HTMLButtonElement>();
  private signature = '';
  private click = (_j: number) => {};
  private length = 0;

  constructor() {
    this.element.append(h('h2', {}, t('Topics')), this.list, this.newThread);
    this.newThread.addEventListener('click', () => this.click(this.length));
    this.element.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...this.rows.values(), ...(!this.newThread.hidden ? [this.newThread] : [])];
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0) return;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : i + (event.key === 'ArrowUp' ? -1 : 1);
      if (buttons[next]) { event.preventDefault(); buttons[next].focus(); }
    });
  }

  update(boards: Shown[], now: number, server: string | null, go: (j: number) => void) {
    this.click = go; this.length = boards.length;
    this.element.hidden = !boards.length && !server;
    this.newThread.hidden = !server;
    this.newThread.setAttribute('aria-current', String(!!server && now === boards.length));
    const signature = JSON.stringify(boards.map((b) => [b.id, b.name]));
    if (signature !== this.signature) {
      this.signature = signature;
      this.rows = new Map(boards.map((b, i) => {
        const key = h('button', {type: 'button', class: 'topic-key'}, h('span', {}, b.name)) as HTMLButtonElement;
        key.addEventListener('click', () => this.click(i));
        return [b.id, key];
      }));
      this.list.replaceChildren(...[...this.rows.values()].map((key) => h('li', {}, key)));
    }
    for (const [i, b] of boards.entries()) {
      const key = this.rows.get(b.id)!;
      const unread = b.member && boardNew(b.id);
      key.classList.toggle('news', unread);
      key.setAttribute('aria-current', String(now === i));
      key.setAttribute('aria-label', unread ? t('{server} (new posts)', {server: b.name}) : b.name);
    }
  }

  focusNew() { this.newThread.focus({preventScroll: true}); }
  focusCurrent() { this.list.querySelector<HTMLElement>('[aria-current="true"]')?.focus({preventScroll: true}); }
}
