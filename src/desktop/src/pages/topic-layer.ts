import {h} from '../dom.ts';
import {pageHead} from './common.ts';
import type {Context} from './context.ts';
import {bench, benchOnScreen, type Bench} from './bench.ts';
import {timeline} from './topic.ts';

// Topic is an operation, as File is: laid over whatever page is showing,
// never a page of its own. Where the page is a bench (Forge, Git) it is that
// bench's Post lane: Topic over the center, the right pane where it was,
// the field at the foot purple. Over any other page it brings a bench of its
// own over the page: Topic in the center, the field at its foot, and the
// right pane for the repo last open (whose Prompt starts only when asked).
//
// Resting the pointer on Topic's icon brings it out, and it stays for
// LINGER after the pointer leaves; a press brings it out to stay. A press
// outside it, Escape, or a second press puts it away. While one is writing
// a post it stays.

const OPEN_DELAY = 300;
const LINGER = 8000;

export class TopicLayer {
  /** Over a page without a bench: a bench of its own. */
  readonly element: HTMLElement;
  private ctx: Context;
  private trigger: HTMLElement | null = null;
  private timer = 0;
  private own: Bench | null = null;
  /** The page's bench it is the Post lane of, while out there. */
  private on: Bench | null = null;
  private pinned = false;

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.element = h('div', {class: 'topic-layer', id: 'topic-layer', role: 'dialog', 'aria-label': 'Topic'});
    document.addEventListener('pointerdown', (event) => {
      if (!this.isOpen) return;
      const at = event.target as Node;
      if (this.trigger?.contains(at) || this.area()?.contains(at)) return;
      this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.isOpen || event.defaultPrevented) return;
      // Escape in a field with words in it is the field's own (clear, or leave it).
      if ((event.target as HTMLElement).closest?.('.say-in')) return;
      this.close();
      this.trigger?.focus();
    });
  }

  get isOpen() { return this.own !== null || this.on !== null; }

  /** What counts as Topic while it is out: a press there keeps it. */
  private area(): HTMLElement | null {
    return this.own ? this.element : this.on?.element.querySelector('.center') ?? null;
  }

  /** The rail's Topic button. */
  attach(button: HTMLElement) {
    this.trigger = button;
    button.setAttribute('aria-controls', 'topic-layer');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('pointerenter', () => this.later(true, this.isOpen ? 0 : OPEN_DELAY));
    button.addEventListener('pointerleave', () => this.leave());
    button.addEventListener('click', () => {
      if (this.isOpen && this.pinned) { this.close(); return; }
      this.open(true);
    });
  }

  private leave() { if (!this.pinned) this.later(false, LINGER); }

  private later(open: boolean, after: number) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => (open ? this.open(false) : this.closeIfIdle()), after);
  }

  /** Bring it out; `stay`: by a press, so it stays until put away. */
  open(stay: boolean) {
    clearTimeout(this.timer);
    if (stay) this.pinned = true;
    if (!this.isOpen) {
      const page = benchOnScreen();
      if (page) {
        this.on = page;
        page.lane('post');
        page.element.addEventListener('lane', this.lane);
        const area = this.area();
        area?.addEventListener('pointerenter', this.hold);
        area?.addEventListener('pointerleave', this.release);
      } else {
        const center = h('section', {class: 'flow', tabindex: '0', 'aria-label': 'Topic'});
        center.append(h('div', {class: 'topic'}, pageHead('topic'), timeline(center)));
        this.own = bench({main: center, reveal: (path) => { if (this.ctx.repo) this.ctx.openRepo(this.ctx.repo, path); },
          go: (id) => { this.close(); this.ctx.go(id); }, topicIsMain: () => true, lazy: true});
        this.own.setRepo(this.ctx.repo);
        this.own.lane('post');
        this.element.replaceChildren(this.own.element);
        this.element.addEventListener('pointerenter', this.hold);
        this.element.addEventListener('pointerleave', this.release);
        document.body.append(this.element);
        this.element.classList.add('open');
      }
      this.trigger?.setAttribute('aria-expanded', 'true');
    }
    if (stay) (this.own ?? this.on)?.lane('post', true);
  }

  private hold = () => clearTimeout(this.timer);
  /** Shell chosen on the page's bench: Topic is away, as if put away here. */
  private lane = (event: Event) => { if ((event as CustomEvent).detail === 'shell' && this.on) this.close(); };
  private release = () => this.leave();

  /** Put away after lingering, unless a post is being written. */
  private closeIfIdle() {
    const area = this.area();
    const writing = area?.closest('.work')?.querySelector<HTMLTextAreaElement>('.say-post .say-in');
    if (writing && (writing.value.trim() || document.activeElement === writing)) return;
    this.close();
  }

  close() {
    clearTimeout(this.timer);
    this.pinned = false;
    if (this.on) {
      const area = this.area();
      area?.removeEventListener('pointerenter', this.hold);
      area?.removeEventListener('pointerleave', this.release);
      const page = this.on;
      this.on = null;
      page.element.removeEventListener('lane', this.lane);
      if (page.element.isConnected && page.current === 'post' && !page.topicIsMain) page.lane('shell');
    }
    if (this.own) {
      this.element.removeEventListener('pointerenter', this.hold);
      this.element.removeEventListener('pointerleave', this.release);
      this.element.classList.remove('open');
      this.element.replaceChildren();
      this.element.remove();
      this.own = null;
    }
    this.trigger?.setAttribute('aria-expanded', 'false');
  }
}
