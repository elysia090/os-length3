// A deed's button while the deed is under way, on Git's page (a step, Commit on main, Reopen, Create).

/**
 * `b` held while its deed is under way: not pressed again, keeping its look and its word (it is the one pressed, not
 * one that cannot be), a short line running under the word (styles.css [aria-busy]). Let go (`on` false, the deed
 * failed), it can be pressed again. Done, it stays held until the drawing after takes it away, but never says it is
 * under way for longer than a deed takes.
 */
export function busy(b: HTMLButtonElement, on: boolean) {
  // (Held, not disabled: a button disabled under the keyboard gave the keyboard to the page's body, and the next ↑ or ↓
  // went nowhere. A press while it is held is let go by what pressed it: held(b).)
  if (!on) { b.removeAttribute('aria-busy'); b.removeAttribute('aria-disabled'); return; }
  b.setAttribute('aria-disabled', 'true');
  b.setAttribute('aria-busy', 'true');
  setTimeout(() => b.removeAttribute('aria-busy'), 8000);
}

/** `b` is held: its deed under way, or not to be done now (aria-disabled). */
export const held = (b: HTMLElement) => b.getAttribute('aria-disabled') === 'true';
