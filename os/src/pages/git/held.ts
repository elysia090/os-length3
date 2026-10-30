// A deed's button while the deed is under way, on Git's page (a step, Commit on main, Reopen, Create).

/**
 * `b` held while its deed is under way: not pressed again, keeping its look and its word (it is the one pressed, not
 * one that cannot be), a short line running under the word (styles.css [aria-busy]). Let go (`on` false, the deed
 * failed), it can be pressed again. Done, it stays held until the drawing after takes it away, but never says it is
 * under way for longer than a deed takes.
 */
export function busy(b: HTMLButtonElement, on: boolean) {
  b.disabled = on;
  if (!on) { b.removeAttribute('aria-busy'); return; }
  b.setAttribute('aria-busy', 'true');
  setTimeout(() => b.removeAttribute('aria-busy'), 8000);
}
