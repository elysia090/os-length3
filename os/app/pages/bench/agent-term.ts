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

  /** Where its words go next: under all it has done so far. */
  answer(_after: HTMLElement): HTMLElement {
    return this.#add(h('div', {class: 'agent-words waiting'}));
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
    const out = output.endsWith('\n') || !output ? output : `${output}\n`;
    this.#add(h('div', {class: 'agent-run'}, h('span', {class: 'ps'}, this.#ps), h('span', {class: 'cmd'}, `${line.trim()}\n`), out,
      ...(status ? [h('span', {class: 'agent-exit'}, t('exit {n}', {n: String(status)}))] : [])));
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
