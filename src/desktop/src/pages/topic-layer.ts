import {h} from '../dom.ts';
import {t} from '../i18n.ts';
import {connection, RemoteError} from '../remote.ts';
import {LIMIT} from '../topic.ts';
import {pageHead} from './common.ts';
import type {Context} from './context.ts';
import {postNow, sharing, timeline} from './topic.ts';

// Topic is an operation, as File is: laid over whatever page is showing,
// never a page of its own, and the same over every page. It has the shape
// of the bench without being one: the timeline in the center with a box at
// its foot to post from (the prompt box's plain look; Enter posts,
// Shift+Enter is a new line), and on the right, where a repo's reference
// and Prompt would be, what Topic shares with whom (topic.ts sharing()).
// No Prompt is here: Topic is for people, the Prompt for a repo.
//
// Resting the pointer on Topic's icon brings it out, and it stays for
// LINGER after the pointer leaves; a press brings it out to stay. A press
// outside it, Escape, or a second press puts it away. While a post is being
// written it stays.

const OPEN_DELAY = 300;
const LINGER = 8000;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class TopicLayer {
  readonly element: HTMLElement;
  private ctx: Context;
  private trigger: HTMLElement | null = null;
  private timer = 0;
  private pinned = false;
  private field: HTMLTextAreaElement | null = null;

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.element = h('div', {class: 'topic-layer', id: 'topic-layer', role: 'dialog', 'aria-label': 'Topic'});
    this.element.addEventListener('pointerenter', () => clearTimeout(this.timer));
    this.element.addEventListener('pointerleave', () => this.leave());
    document.addEventListener('pointerdown', (event) => {
      const at = event.target as Node;
      if (!this.isOpen || this.trigger?.contains(at) || this.element.contains(at)) return;
      this.close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.isOpen) return;
      this.close();
      this.trigger?.focus();
    });
  }

  get isOpen() { return this.element.isConnected; }

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
      this.element.replaceChildren(this.build());
      document.body.append(this.element);
      this.trigger?.setAttribute('aria-expanded', 'true');
    }
    if (stay) this.field?.focus();
  }

  /** Put away after lingering, unless a post is being written. */
  private closeIfIdle() {
    const f = this.field;
    if (f && (f.value.trim() || document.activeElement === f)) return;
    this.close();
  }

  close() {
    clearTimeout(this.timer);
    this.pinned = false;
    this.field = null;
    this.element.replaceChildren();
    this.element.remove();
    this.trigger?.setAttribute('aria-expanded', 'false');
  }

  private build(): HTMLElement {
    const flow = h('section', {class: 'flow', tabindex: '0', 'aria-label': 'Topic'});
    flow.append(h('div', {class: 'topic'}, pageHead('topic'), timeline(flow)));
    const note = h('p', {class: 'prompt-note muted small', role: 'status'});
    let box: HTMLElement;
    if (connection()) {
      const field = h('textarea', {class: 'prompt-in', rows: '1', maxlength: String(LIMIT), 'aria-label': t('New post'),
        placeholder: t('To your contacts and a few readers first')}) as HTMLTextAreaElement;
      this.field = field;
      const fit = () => { field.style.height = 'auto'; field.style.height = `${field.scrollHeight}px`; };
      // What is left is said only once it runs short.
      const left = () => { const n = LIMIT - field.value.length; note.textContent = n < 100 ? t('{n} characters left', {n}) : ''; };
      let posting = false;
      field.addEventListener('input', () => { fit(); left(); });
      field.addEventListener('keydown', async (event) => {
        // As the prompt box: Enter sends, Shift+Enter is a new line.
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        if (posting || !field.value.trim()) return;
        posting = true;
        note.replaceChildren();
        try {
          await postNow(field.value);
          field.value = '';
          fit();
        } catch (e) {
          if (e instanceof RemoteError && e.status === 409) {
            const inbox = h('button', {type: 'button', class: 'button small-button'}, t('Go to Inbox'));
            inbox.addEventListener('click', () => { this.close(); this.ctx.go('inbox'); });
            note.replaceChildren(t('Posting needs an address. Claim one in Inbox.'), ' ', inbox);
          } else note.textContent = message(e);
        } finally { posting = false; }
      });
      box = h('form', {class: 'prompt'}, field);
      box.addEventListener('submit', (event) => event.preventDefault());
    } else {
      // Reading needs nothing; writing needs an account.
      const signIn = h('button', {type: 'button', class: 'button small-button'}, t('Sign in'));
      signIn.addEventListener('click', () => { this.close(); this.ctx.go('remote'); });
      box = h('div', {class: 'prompt topic-signed-out'}, h('span', {class: 'muted'}, t('Sign in to post.')), signIn);
    }
    const center = h('div', {class: 'center'}, flow, h('div', {class: 'dock'}, box, note));
    const side = h('aside', {class: 'side topic-side', 'aria-label': t('What Topic shares, and with whom')}, sharing());
    return h('div', {class: 'work no-strip'}, center, side);
  }
}
