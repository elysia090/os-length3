import {fieldMoved} from '../../ui/caret.ts';
import {still} from '../../ui/glide.ts';
import type {Session} from './terminal.ts';
import {sessionIfAny} from './sessions.ts';

// The box's pill while it runs (box.ts): the prompt line the repo's shell waits at, and its lamp, lit while the shell
// runs. The repo's Prompt is followed for them, and a new one from the moment it is started again.

interface PillParts {
  /** The pill (its state lights its lamp) and the prompt line in it. */
  chip: HTMLElement;
  waits: HTMLElement;
  /** The repo the box works on, and whether the Prompt is up over the center. */
  repo(): string | null;
  up(): boolean;
  /** Told when another Prompt is followed. */
  followed(): void;
}

/** The Prompt the box follows, and the prompt line its pill says. */
export class PillLine {
  /** The Prompt followed (its prompt line, its lamp): the repo's own, a new one once it is started again. */
  #followed: Session | null = null;
  #unwatch: (() => void) | null = null;
  /** The prompt line each repo's shell last waited at: the pill's at rest, while a line runs or before it starts. */
  readonly #lastLine = new Map<string, string>();
  #saying = 0;
  #speaking = 0;
  readonly #p: PillParts;

  constructor(p: PillParts) { this.#p = p; }

  /** The repo's Prompt followed (the one it has now, if any), and its prompt line said. */
  follow() {
    const repo = this.#p.repo(), s = repo ? sessionIfAny(repo) ?? null : null;
    if (s !== this.#followed) {
      this.#followed = s;
      this.#unwatch?.();
      this.#unwatch = s ? s.watch(() => this.said()) : null;
      this.#p.followed();
    }
    this.said();
  }

  /**
   * The prompt line: up, the one the shell waits at now (none while a line runs); at rest, the last it waited at.
   * Come back after a run, it comes once what the run printed has come in (output.ts), as a terminal's does.
   */
  said() {
    const repo = this.#p.repo(), s = repo ? sessionIfAny(repo) : undefined;
    // Started again: the new one is followed from now on.
    if (this.#followed && (s ?? null) !== this.#followed) { this.follow(); return; }
    const line = s?.promptLine.trimEnd() ?? '';
    if (repo && line) this.#lastLine.set(repo, line);
    this.#p.chip.dataset.state = !s ? 'none' : s.ended ? 'ended' : s.running ? 'on' : 'starting';
    this.#waitsAt(!repo ? '' : this.#p.up() ? line : this.#lastLine.get(repo) ?? `${repo} $`, s);
  }

  /** `now` the prompt line in the pill: at once, or (up, after a run) once what the run printed has come in. */
  #waitsAt(now: string, s: Session | undefined) {
    const {waits} = this.#p;
    cancelAnimationFrame(this.#saying);
    clearTimeout(this.#speaking);
    if (!(this.#p.up() && now && !waits.textContent) || still()) { waits.textContent = now; return; }
    // After the frame that draws what came, so the time its lines take to come in is known; then the prompt line and
    // the caret after it come together, as the last line comes.
    this.#saying = requestAnimationFrame(() => {
      this.#speaking = window.setTimeout(() => {
        waits.textContent = now;
        fieldMoved();
        waits.animate([{opacity: 0}, {opacity: 1}], {duration: 140, easing: 'ease-out'});
      }, s?.settlesIn() ?? 0);
    });
  }
}
