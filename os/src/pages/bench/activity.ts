import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {paced, still} from '../../ui/glide.ts';
import type {Run} from './terminal.ts';

// While a line runs in a Prompt, what it is doing, said under its output once it has taken a moment (terminal.ts):
// reading input (Interrupt reaches it: the kernel is paused), running and still talking (Interrupt lands when it next
// stops), sleeping (running, quiet, and Interrupt reaches it: the kernel is paused until its time), or running without
// a word for a while, when a busy worker cannot hear anything and only starting again is sure (what it changed since
// the last line is not written back).

/** What a Prompt can be asked from its activity line, and whether it is running. */
interface ActivityWays {
  live(): boolean;
  interrupt(): void;
  restart(): void;
}

/** The line under a Prompt's output that says what the line running is doing. */
export class Activity {
  // Not a live region: its count goes up each second, which a screen reader would read out each second.
  readonly element = h('div', {class: 'term-activity small'});
  /** When the worker last said anything. */
  heard = 0;
  /** Paused with a run open: what runs reads what is typed. */
  inputWait = false;
  /** Asleep with a run open, until this time (Date.now()): it goes on by itself, and hears Interrupt meanwhile. */
  sleepsUntil = 0;
  #ticker = 0;
  #leaving: Animation | null = null;
  readonly #ways: ActivityWays;

  constructor(ways: ActivityWays) { this.#ways = ways; }

  /** `run`, the last line sent, followed each second while it runs; none, or done, what was said goes. */
  follow(run: Run | undefined) {
    clearInterval(this.#ticker);
    if (!this.#ways.live() || !run || run.ms !== null) { this.#unfollow(); return; }
    this.#leaving?.cancel();
    this.#leaving = null;
    // Made once for the run and only moved in or out: a button drawn anew each second would drop the keyboard on it.
    const said = h('span', {class: 'muted'});
    const cut = h('button', {class: 'button small-button', type: 'button'}, t('Interrupt'));
    cut.addEventListener('click', () => this.#ways.interrupt());
    const again = h('button', {class: 'button small-button', type: 'button'}, t('Stop and restart'));
    again.addEventListener('click', () => this.#ways.restart());
    const paint = () => {
      if (run.ms !== null || !this.#ways.live()) { clearInterval(this.#ticker); this.#unfollow(); return; }
      const parts = this.#parts(run, said, cut, again);
      const shown = [...this.element.childNodes];
      if (parts.length !== shown.length || parts.some((x, i) => x !== shown[i])) this.element.replaceChildren(...parts);
    };
    paint();
    this.#ticker = window.setInterval(paint, 1000);
  }

  /** What is said of `run` now (`said`, its words), with the buttons that reach it then. */
  #parts(run: Run, said: HTMLElement, cut: HTMLElement, again: HTMLElement): HTMLElement[] {
    const s = Math.floor((Date.now() - run.started) / 1000);
    // A sleep is quiet but heard: quiet is counted from when it is over.
    const now = Date.now(), quiet = Math.floor((now - Math.max(this.heard, Math.min(this.sleepsUntil, now))) / 1000);
    said.textContent = this.inputWait ? t('Waiting for input') : `${t('Running ({n}s)', {n: s})}${quiet >= 5 ? ` · ${t('No output')}` : ''}`;
    return this.inputWait ? [said, cut] : s < 2 ? [] : quiet >= 10 ? [said, cut, again] : [said, cut];
  }

  /** What the run was doing, once it is done: put aside to its right, not gone at once. */
  #unfollow() {
    if (this.#leaving) return;
    if (!this.element.firstChild || still()) { this.element.replaceChildren(); return; }
    const going = this.#leaving = this.element.animate([{opacity: 1}, {opacity: 0, translate: '12px 0'}], {duration: paced(170), easing: 'ease-in'});
    going.finished.then(() => { if (this.#leaving === going) { this.#leaving = null; this.element.replaceChildren(); } }, () => {});
  }

  /** The run cut: what it was doing goes as it is cut, not once the shell says it is back. */
  cut() {
    clearInterval(this.#ticker);
    this.#unfollow();
  }

  /** The Prompt ended: nothing is said here any more, at once. */
  end() {
    clearInterval(this.#ticker);
    this.element.replaceChildren();
  }
}
