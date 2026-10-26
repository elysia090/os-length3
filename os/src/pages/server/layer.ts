import {h} from '../../ui/dom.ts';
import {onConnection} from '../../remote/connection.ts';
import type {Context} from '../context.ts';
import {paced} from '../../ui/glide.ts';
import {ServerView} from './view.ts';
import {seenNow} from './talk.ts';

// Server is an operation, as File is: laid over whatever page is showing,
// never a page of its own. It is the one thing whose subject is people, not
// a repo: a server is a group of people who know each other, and each of
// its boards is a conversation and a TODO they keep together.
//
// It has the bench's shape. The servers one is in run as chips on the top
// line (+ makes one), and at its right end the server's gear. Under them its
// boards are boxes side by side, as the issues are: the board on screen in
// full, its neighbours' edges showing, an edge (or ← →) the way to them, and
// the last box a new board. A board's TODO, the same list as Home's, is
// pinned at the top of its box, written there by its people; its talk runs
// under it, and the box at the foot writes in it. On the right, where a repo's reference would be:
// who is in the server, then the repos they show in it (pressing one shows
// it as it was last pushed; a repo shown is only seen there, never written).
//
// What changes the server for everyone, who is in it, how far a board is
// open, what is shown and as whose, leaving it, is a step away, behind the
// gear; and what reaches past its people asks before it does.
//
// Resting the pointer on its icon a deliberate moment (it covers the page, so
// longer than File's small tree) brings it out, and it stays for LINGER after
// the pointer leaves, unless the pointer goes on to another place on the rail;
// a press brings it out to stay. It comes out whole, not as a frame its parts
// fill one by one: the rest makes it ready unseen first, and a press waits a
// moment at most for what it opens on. A press outside
// it, Escape, or a second press puts it away (Escape from behind the gear
// goes back to the boards first). While something is being written it stays,
// and a press outside does not put it away while the box at the foot holds
// words (they are kept with their board either way).
//
// What came in and was not seen yet is marked as the rail marks it: a dot on
// a server's chip and on a board's #, gone once its talk's foot is in view.

const OPEN_DELAY = 600;
const LINGER = 8000;
/** A rest this long on its icon makes it ready unseen (OPEN_DELAY brings it out): passing over it reads nothing. */
const READY_AFTER = 200;
/** The longest it waits, unseen, for what it opens on before it comes out all the same. */
const WHOLE = 300;

export class ServerLayer {
  readonly element: HTMLElement;
  private ctx: Context;
  private trigger: HTMLElement | null = null;
  private timer = 0;
  private pinned = false;
  /** Something being written here (a post, a TODO, a name): it stays out while there is. */
  private writing = (): boolean => false;
  /** Words in the box at the foot: a press outside leaves the layer out. */
  private holding = (): boolean => false;
  /** Escape from behind the gear, or from a repo shown: back to the boards (true), or nothing to go back from. */
  private back = (): boolean => false;

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.element = h('section', {class: 'server-layer', id: 'server-layer', role: 'dialog', 'aria-label': 'Server'});
    this.element.addEventListener('pointerenter', () => clearTimeout(this.timer));
    this.element.addEventListener('pointerleave', () => this.leave());
    document.addEventListener('pointerdown', (event) => {
      const at = event.target as Node;
      if (!this.isOpen || this.trigger?.contains(at) || this.element.contains(at) || this.holding()) return;
      this.close(true);
    });
    // Signed in or out (or the session ended elsewhere): what is out is built again for who is here now.
    onConnection(() => this.again());
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.isOpen) return;
      if (this.back()) return;
      this.close(true);
      this.trigger?.focus();
    });
  }

  get isOpen() { return this.element.isConnected && !this.leaving && !this.coming; }

  /** The rail's Server button. */
  attach(button: HTMLElement) {
    this.trigger = button;
    button.setAttribute('aria-controls', 'server-layer');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('pointerenter', () => {
      // Resting there a moment, it is made ready unseen, so what comes out after the rest comes whole.
      if (!this.element.isConnected) { clearTimeout(this.readying); this.readying = window.setTimeout(() => this.ready(), READY_AFTER); }
      this.later(true, this.isOpen ? 0 : OPEN_DELAY);
    });
    button.addEventListener('pointerleave', () => this.leave());
    button.addEventListener('click', () => {
      if (this.isOpen && this.pinned) { this.close(true); return; }
      this.open(true);
    });
  }

  private leave() {
    clearTimeout(this.readying);
    if (this.pinned) return;
    // Made ready for a rest that did not last: let go, unseen.
    if (this.coming) { this.close(); return; }
    this.later(false, LINGER);
  }

  /** Made ready (or being), not out yet: built unseen, while the rest is made sure of or what it opens on is read. */
  private coming = false;
  private readying = 0;
  /** Whether what it opens on is drawn (view.ts settled). */
  private settled = (): boolean => true;

  /** Built, unseen and not pressed, for coming out whole: what it opens on read while the pointer rests. */
  private ready() {
    if (this.element.isConnected) return;
    this.coming = true;
    this.element.classList.add('coming');
    this.element.setAttribute('aria-hidden', 'true');
    this.element.replaceChildren(this.build());
    document.body.append(this.element);
  }

  /**
   * Out, once what it opens on is drawn (the servers, the board on screen's talk and TODO, its people) or after
   * WHOLE at the most: it comes out once, whole, not as a frame its parts then fill one by one.
   */
  private show() {
    const asked = performance.now();
    const out = () => {
      if (!this.coming || !this.element.isConnected) return;
      if (!this.settled() && performance.now() - asked < WHOLE) { requestAnimationFrame(out); return; }
      this.coming = false;
      this.element.classList.remove('coming');
      this.element.removeAttribute('aria-hidden');
      seenNow();
      // Pressed out while it was made ready: the keyboard goes in, as it does when a press builds it.
      if (this.pinned && !this.element.contains(document.activeElement)) this.keyboardIn();
    };
    out();
  }

  /** The keyboard into it: the name being made, or the box to write in. */
  private keyboardIn() {
    [...this.element.querySelectorAll<HTMLElement>('.server-name-in, .prompt-in')].find((el) => el.checkVisibility())?.focus();
  }

  /** The pointer on another place on the rail: the layer a rest brought out, not pressed, nothing written, goes at once. */
  passedBy() { if (this.isOpen && !this.pinned && !this.writing()) this.close(true); }

  private later(open: boolean, after: number) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => (open ? this.open(false) : (this.writing() ? undefined : this.close(true))), after);
  }

  /** Bring it out; `stay`: by a press, so it stays until put away. */
  open(stay: boolean) {
    clearTimeout(this.timer);
    // Brought back while it was going: it is built again, at once.
    if (this.leaving) { this.leaving.cancel(); this.leaving = null; this.element.style.pointerEvents = ''; this.element.replaceChildren(); this.element.remove(); }
    clearTimeout(this.readying);
    if (stay) this.pinned = true;
    // Brought out to stay, it covers the page: the keyboard goes from the rail into it, not to the page behind it.
    if (stay) document.getElementById('page')?.setAttribute('inert', '');
    if (this.isOpen) {
      // Out already because the pointer rested on Server, and now pressed: the keyboard goes in as it does when a
      // press brings it out (the name being made, or the box to write in), not left on the rail where Enter would
      // put it away again.
      if (stay && !this.element.contains(document.activeElement)) this.keyboardIn();
      return;
    }
    this.ready();
    this.trigger?.setAttribute('aria-expanded', 'true');
    this.show();
  }

  /** Its going, while it goes (put away by the person, it fades the way it came from). */
  private leaving: Animation | null = null;

  /**
   * Put it away. `gently`: by the person (Escape, a press outside, the rail's Server, the pointer gone), it goes the
   * way it came, fading (180 ms); otherwise (another page come to, a way out of it taken) at once, as the page moves.
   */
  close(gently = false) {
    clearTimeout(this.timer);
    clearTimeout(this.readying);
    // Never out (made ready for a rest that did not last): nothing to see go.
    if (this.coming) { gently = false; this.coming = false; this.element.classList.remove('coming'); this.element.removeAttribute('aria-hidden'); }
    this.pinned = false;
    document.getElementById('page')?.removeAttribute('inert');
    this.writing = () => false;
    this.holding = () => false;
    this.back = () => false;
    this.trigger?.setAttribute('aria-expanded', 'false');
    const gone = () => { this.leaving = null; this.element.style.pointerEvents = ''; this.element.replaceChildren(); this.element.remove(); };
    if (!gently || !this.element.isConnected || matchMedia('(prefers-reduced-motion: reduce)').matches) { this.leaving?.cancel(); gone(); return; }
    if (this.leaving) return;
    // Going, it is no longer pressed: a press lands on what is under it.
    this.element.style.pointerEvents = 'none';
    this.leaving = this.element.animate([{opacity: 1, transform: 'none'}, {opacity: 0, transform: 'translateX(-16px)'}], {duration: paced(180), easing: 'ease-in'});
    this.leaving.finished.then(gone, () => {});
  }

  /** What is in it, built for who is here now (view.ts). */
  private build(): HTMLElement {
    const view = new ServerView({
      ctx: this.ctx,
      pinned: () => this.pinned,
      close: () => this.close(),
      again: () => this.again(),
      holding: (words) => { this.holding = words; },
    });
    this.writing = () => view.writing();
    this.back = () => view.back();
    this.settled = () => view.settled();
    return view.work;
  }

  /** Out (or being made ready), it is built again: signed in or out, or the Remote answering again. */
  private again() { if (this.element.isConnected && !this.leaving) this.element.replaceChildren(this.build()); }
}
