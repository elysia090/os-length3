// Escape is the way out (DESIGN §14, close). Of a menu, of the tree, of a thing called up: each says so where it is
// made. Of an ask (a name to write out before a repo goes, a deed to say yes to, a field to name a thing in): its
// Cancel, wherever the ask is, so Escape is never the one key that does nothing in the one place a person most wants
// out. Each ask's Cancel is marked as its way out once, where it is made (wayOut); Escape with the keyboard in the ask
// presses it, before whatever stands round the ask hears the key (the desk, the page, whose Escape does another thing).
// Out of an ask, Escape is theirs.

/** What holds an ask: its group (what the ask is named by), or the sheet it is asked in. */
const ASK = '[role=group], [role=dialog], .pop, .card, .row-ask';

/** `no` is the way out of the ask it stands in: Escape presses it. */
export function wayOut<T extends HTMLElement>(no: T): T {
  no.dataset.wayOut = '';
  no.setAttribute('aria-keyshortcuts', 'Escape');
  return no;
}

/** The way out of the ask the keyboard is in, if it is in one: the Cancel standing in the same ask, shown and pressable. */
export function wayOutOf(at: Element | null): HTMLElement | null {
  const ask = at?.closest(ASK);
  if (!ask) return null;
  return [...ask.querySelectorAll<HTMLElement>('[data-way-out]')].find((b) => b.closest(ASK) === ask && b.getClientRects().length
    && !(b as HTMLButtonElement).disabled && !b.closest('[inert], [hidden]')) ?? null;
}

/** Escape in an ask, heard first (before anything round it): its way out pressed. */
export function waysOut() {
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
    const out = wayOutOf(document.activeElement);
    if (!out) return;
    e.preventDefault();
    e.stopPropagation();
    out.click();
  }, true);
}
