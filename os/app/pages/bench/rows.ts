import {h} from '../../ui/dom.ts';
import {t} from '../../i18n/i18n.ts';
import {cutWhenLonger} from '../../ui/cut.ts';
import type {Run} from './sessions.ts';

// The right pane of Forge and Git: what was done in the repo, a big row each, newest last, one for both pages. A line run, its bar in
// green (it ended well), red (it failed, its exit status said) or ink (still running), the line itself in the display
// face; what the box did that is not the shell's (an issue written, a TODO added, what the Agent read or edited), its
// pill and its words; the Agent's words under the question they answer. Every row says at most two lines, the second
// fading out partway along it: the pane is a notification, not a second workplace (the run is read in the Prompt's
// box, a press away; what a note names is where it goes).

/** What the rows follow of a Prompt: the lines it ran, and how to hear when they change. */
export interface Runs { readonly runs: Run[]; watch(fn: () => void): () => void }

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});

/** A repo's flow as the pane shows it. */
export class Rows {
  readonly element = h('div', {class: 'pane-rows', role: 'log'});
  readonly #rows = new Map<Run, HTMLElement>();
  /** How a run pressed is read: as the page that holds the rows now reads it (the Prompt's box, at it; or Output's). */
  open: (run: Run) => void = () => {};

  /** `prompt`'s runs followed. */
  constructor(label: string, prompt: Runs) {
    this.element.setAttribute('aria-label', label);
    prompt.watch(() => this.#sync(prompt.runs));
    this.#sync(prompt.runs);
  }

  /** On screen again (in another page's pane, or its page come back to): at the newest. */
  shown() {
    this.element.scrollTo({top: this.element.scrollHeight});
  }

  #sync(runs: Run[]) {
    for (const run of runs) {
      let row = this.#rows.get(run);
      if (!row) {
        row = h('button', {type: 'button', class: 'pane-row run'},
          h('span', {class: 'pane-bar', 'aria-hidden': 'true'}), h('span', {class: 'pane-line'}, run.line), h('span', {class: 'pane-at'}));
        row.addEventListener('click', () => this.open(run));
        this.#rows.set(run, row);
        this.#add(row);
        cutWhenLonger(row.querySelector('.pane-line')!);
      }
      const ended = run.ms !== null, failed = ended && (run.status ?? 0) !== 0;
      row.dataset.state = !ended ? 'running' : failed ? 'failed' : 'done';
      const at = row.querySelector('.pane-at')!;
      at.replaceChildren(...(failed ? [h('b', {class: 'pane-exit'}, t('exit {n}', {n: String(run.status)}))] : []), time(run.started));
    }
  }

  #add(row: HTMLElement) {
    this.element.append(row);
    if (row.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      row.animate([{opacity: 0, translate: '0 -4px'}, {opacity: 1, translate: '0 0'}], {duration: 360, easing: 'cubic-bezier(.2, .8, .2, 1)'});
    this.element.scrollTo({top: this.element.scrollHeight});
  }

  /** Something the box did that is not the shell's (`head`, its words), a row of its own; pressed, `go` to it. */
  note(head: string, words: string, go: (row: HTMLElement) => void): HTMLElement {
    const text = words.replace(/\s+/g, ' ').trim();
    const row = h('button', {type: 'button', class: 'pane-row note', 'aria-label': `${head} ${text}`},
      h('span', {class: 'pane-bar', 'aria-hidden': 'true'}), h('span', {class: 'pane-line'}, text), h('span', {class: 'pane-at'}, head));
    row.addEventListener('click', () => go(row));
    this.#add(row);
    cutWhenLonger(row.querySelector('.pane-line')!);
    return row;
  }

  /** Under the question `row` stands for, where the Agent's words come in (a quiet ellipsis until they do). */
  answer(row: HTMLElement): HTMLElement {
    const el = h('div', {class: 'pane-answer waiting'});
    row.after(el);
    // Its words, as they come, cut at two lines; pressed, all of them.
    cutWhenLonger(el, true);
    el.addEventListener('click', () => el.classList.toggle('whole'));
    return el;
  }
}
