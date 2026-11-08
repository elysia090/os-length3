import {h} from '../../ui/dom.ts';
import {t} from '../../i18n/i18n.ts';
import type {Flow} from './agent.ts';

// The Agent's own terminal, born on the desk beside the person's when it is asked from there (`agent ...` run in the
// person's Prompt): what it was asked, then what it does as it is played (play.ts), at a person's pace, in its own
// Prompt's lines: each command typed after its prompt and what it printed, each file it read or edited a quiet line
// (pressed, the file), its words where it says them. The person's terminal beside it stays the person's: nothing the
// Agent does is typed there, and nothing it does waits on the person.

/** The most lines the Agent's terminal keeps; the first go as more come. */
const KEPT = 400;

export class AgentTerm implements Flow {
  readonly element: HTMLElement;
  readonly #out = h('div', {class: 'term-out agent-out', 'aria-live': 'polite'});
  readonly #typed = h('span', {class: 'agent-typed'});
  readonly #line: HTMLElement;
  readonly #ps: string;

  constructor(repo: string) {
    this.#ps = `${repo} $ `;
    // Its prompt line waits at the foot, as a terminal's does; while a command is typed, the cell after it is the caret.
    this.#line = h('div', {class: 'agent-prompt'}, h('span', {class: 'ps'}, this.#ps), this.#typed, h('span', {class: 'agent-cur', 'aria-hidden': 'true'}));
    this.element = h('section', {class: 'desk-term agent-term', tabindex: '-1', 'aria-label': t('Agent')}, this.#out, this.#line);
  }

  /** `question` asked of it: the head of what follows. */
  asked(question: string): HTMLElement {
    return this.#add(h('div', {class: 'agent-asked'}, question));
  }

  /** A step it took on a file (read, edited), a quiet line; pressed, `go` (the file opened). */
  note(_head: string, words: string, go: (row: HTMLElement) => void): HTMLElement {
    const row = h('button', {type: 'button', class: 'agent-step'}, words) as HTMLButtonElement;
    row.addEventListener('click', () => go(row));
    return this.#add(row);
  }

  /** Where its words go next: under all it has done so far (where they were typed as it said them, if they were). */
  answer(_after: HTMLElement): HTMLElement {
    const said = this.#said;
    this.#said = null;
    return said ?? this.#add(h('div', {class: 'agent-words waiting'}));
  }

  /** Words typed as it says them, before they are set as words (answer): where they wait under the question, else
   * under all it has done so far. */
  #said: HTMLElement | null = null;
  saying(): {put(text: string): void} {
    const last = this.#out.lastElementChild;
    const el = last instanceof HTMLElement && last.matches('.agent-words.waiting') ? last : (this.#said = this.#add(h('div', {class: 'agent-words'})));
    const p = h('p', {class: 'answer-p'});
    return {put: (text) => {
      el.classList.remove('waiting');
      if (p.parentElement !== el) el.replaceChildren(p);
      p.textContent = text;
      this.#out.scrollTop = this.#out.scrollHeight;
    }};
  }

  /** Its prompt line taken to type a command into: `put` what is typed so far; `done` gives the line back, empty. */
  typing(): {put(text: string): void; sent(): void; done(): void} {
    this.element.classList.add('typing');
    return {
      put: (text) => { this.#typed.textContent = text; },
      sent: () => { this.#typed.textContent = ''; },
      done: () => { this.#typed.textContent = ''; this.element.classList.remove('typing'); },
    };
  }

  /** A command it ran, shown with what it printed and, ended otherwise than well, how. */
  shown(line: string, output: string, status: number | null) {
    this.running(line)(output, status);
  }

  /**
   * A command sent and running, as a terminal has it: the command after its prompt, the caret on the line under it and
   * no prompt there until it ends; returns how to show what it printed and, ended otherwise than well, how.
   */
  running(line: string): (output: string, status: number | null) => void {
    const row = this.#add(h('div', {class: 'agent-run'}, h('span', {class: 'ps'}, this.#ps), h('span', {class: 'cmd'}, `${line.trim()}\n`)));
    this.element.classList.add('running');
    return (output, status) => {
      const out = output.endsWith('\n') || !output ? output : `${output}\n`;
      row.append(out, ...(status ? [h('span', {class: 'agent-exit'}, t('exit {n}', {n: String(status)}))] : []));
      this.element.classList.remove('running');
      this.#out.scrollTop = this.#out.scrollHeight;
    };
  }

  #add(el: HTMLElement): HTMLElement {
    this.#out.append(el);
    while (this.#out.childElementCount > KEPT) this.#out.firstElementChild!.remove();
    this.#out.scrollTop = this.#out.scrollHeight;
    return el;
  }
}

/** Each repo's Agent's terminal while the app runs: one, born the first time the Agent is asked there. */
const terms = new Map<string, AgentTerm>();

export function agentTermFor(repo: string): AgentTerm {
  let a = terms.get(repo);
  if (!a) terms.set(repo, a = new AgentTerm(repo));
  return a;
}
