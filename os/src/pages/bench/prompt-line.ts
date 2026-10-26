// The prompt line the shell waits at, as the Prompt knows it in what the shell wrote; and before the shell has first
// waited at one (a cold start is some seconds), the lines sent to it, held for it.

/**
 * The prompt line the shell waits at, if `line` (the last line of what it wrote) is one: `x $ `, `x/src $ ` (the root's
 * shrc), or a path (`/root/x $ `) outside the repo; a run is over when it comes back. '' otherwise.
 */
export const waitsAt = (line: string): string => (/\S \$ $/.test(line) ? line : '');

/** The shell's first prompt line, and what was sent before it came: held, and sent once it comes. */
export class FirstPrompt {
  /** Whether the shell has waited at a prompt line yet. */
  waited = false;
  #held = '';
  #late: ReturnType<typeof setTimeout> | undefined;

  /** `lines` sent before the shell waits: they wait for it. */
  hold(lines: string) { this.#held += lines; }

  /**
   * The shell wrote, its last line a prompt line (`waits`) or not: once it waits, what was held is given to `send`.
   * A prompt line of the person's own (their dotfiles' PS1) is not known for one: a moment after the shell first
   * speaks, it is taken to wait, and what was held goes.
   */
  heard(waits: boolean, send: (lines: string) => void) {
    if (this.waited) return;
    const go = () => {
      if (this.waited) return;
      this.waited = true;
      const held = this.#held;
      this.#held = '';
      // Sent once what came has been drawn, so it is drawn after the prompt line, as it would have been typed there.
      if (held) requestAnimationFrame(() => requestAnimationFrame(() => send(held)));
    };
    if (waits) go();
    else this.#late ??= setTimeout(go, 3000);
  }
}
