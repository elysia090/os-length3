// The keyboard is never dropped (DESIGN.md §1, What one was doing stays).
// A control pressed is often held while its deed runs (disabled) or drawn
// again once it is done, and either takes the keyboard away: the browser
// leaves it on the page's body, and the next Tab starts over at the top.
// Here, when that happens, the keyboard comes back to the same control as
// soon as it is there again (enabled, or drawn anew with the same words in
// the same place), or else, a moment later, to the nearest place still
// standing that takes it (a row of boxes, the page). It never moves the
// keyboard away from where something put it: only from the body, and only
// after the control that had it went, not after a press on nothing.

const CONTROLS = 'button, [href], input, textarea, select, [tabindex]';
/** How long the same control is waited for before the nearest place takes the keyboard. */
const WAIT = 600;

/**
 * A text field drawn again under the keyboard keeps where its caret was and what was selected, when its words are
 * the same (a field taken away still holds both): what is typed next goes where it would have, not after the end.
 */
function carry(from: HTMLElement, to: HTMLElement) {
  const text = (e: HTMLElement): e is HTMLInputElement | HTMLTextAreaElement => e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement;
  if (!text(from) || !text(to) || from.value !== to.value) return;
  try { to.setSelectionRange(from.selectionStart, from.selectionEnd, from.selectionDirection ?? undefined); } catch { /* a field with no caret (a number, a date) */ }
}

const usable = (el: Element): el is HTMLElement =>
  el instanceof HTMLElement && el.isConnected && !(el as HTMLButtonElement).disabled && !el.closest('[hidden], [inert]')
  && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

/** What a control is, as a person tells it from another: its kind, its name and its words. */
const what = (el: Element) => `${el.tagName}|${el.getAttribute('role') ?? ''}|${el.getAttribute('aria-label') ?? ''}|${(el.textContent ?? '').trim()}`;

export function keepFocus(doc: Document = document) {
  let last: HTMLElement | null = null;
  let was = '';
  let around: HTMLElement[] = [];
  let since = 0;
  let timer = 0;

  doc.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!(el instanceof HTMLElement)) return;
    last = el;
    was = what(el);
    around = [];
    for (let p = el.parentElement; p && p !== doc.body; p = p.parentElement) around.push(p);
    since = 0;
  }, true);

  const settle = () => {
    clearTimeout(timer);
    timer = 0;
    const now = doc.activeElement;
    if (now && now !== doc.body) { since = 0; return; }
    if (!last) return;
    // Still there and usable: the keyboard left it by a press elsewhere (or Escape), which is the person's to decide.
    if (!since && usable(last)) return;
    if (!since) since = performance.now();
    if (usable(last)) { last.focus({preventScroll: true}); since = 0; return; }
    const home = around.find((a) => a.isConnected && !a.closest('[hidden]'));
    if (!home) { since = 0; return; }
    const same = [...home.querySelectorAll(CONTROLS)].find((c): c is HTMLElement => what(c) === was && usable(c));
    // The one that went, taken before the focus moves (its focusin makes the new one `last`).
    if (same) { const went = last; same.focus({preventScroll: true}); carry(went, same); since = 0; return; }
    if (performance.now() - since < WAIT) { timer = window.setTimeout(settle, WAIT); return; }
    // Not coming back: the nearest place around it that takes the keyboard, else the page (or the layer) itself.
    const place = around.find((a) => a.isConnected && a.hasAttribute('tabindex') && usable(a))
      ?? around.find((a) => a.isConnected && (a.tagName === 'MAIN' || a.getAttribute('role') === 'dialog'));
    since = 0;
    if (!place) return;
    if (!place.hasAttribute('tabindex')) place.setAttribute('tabindex', '-1');
    // Taken on its own, the place holds the keyboard without a ring round it (a whole page framed in ink, for a
    // card that went); a key pressed there rings it, as the person is then using it.
    place.classList.add('kept');
    const plain = () => { place.classList.remove('kept'); place.removeEventListener('keydown', plain); place.removeEventListener('blur', plain); };
    place.addEventListener('keydown', plain);
    place.addEventListener('blur', plain);
    place.focus({preventScroll: true});
  };
  // Looked at once what changes has been drawn; the wait for the same control is counted from when it went.
  const soon = () => { clearTimeout(timer); timer = window.setTimeout(settle, 0); };
  new MutationObserver(soon).observe(doc.body, {subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'hidden']});
  doc.addEventListener('focusout', (e) => { if (!(e as FocusEvent).relatedTarget) soon(); }, true);
  // A press or a key is the person moving on: what was lost before it is not brought back after it.
  for (const ev of ['pointerdown', 'keydown']) doc.addEventListener(ev, () => { if (doc.activeElement === doc.body) { since = 0; last = null; } }, true);
}
