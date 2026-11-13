// Words said in a few lines at most (the pane's rows: a line run, what was said, a name): cut where they run on, the
// last line fading out partway along (styles: .cut). Whether they run on is measured as they are laid out, and again
// whenever their box changes size (a pane opening, a window narrowed, the faces come in), never once and left.

function measure(el: HTMLElement) {
  // Out of sight (a pane put away, a page not on screen), nothing is measured: it is again when it is laid out.
  if (!el.clientHeight) return;
  // What runs on is a line more at least; a face whose letters stand past its tight line (the display face's, a pixel
  // or two) is not.
  const line = parseFloat(getComputedStyle(el).lineHeight) || 16;
  el.classList.toggle('cut', el.scrollHeight - el.clientHeight > line / 2);
}

const sized = new ResizeObserver((seen) => { for (const {target} of seen) measure(target as HTMLElement); });

/** `el` cut, its last line fading, while what it says runs on past the lines it is given; `growing`, its words still
 * coming (an answer as it is written: past its lines it no longer changes size, so what comes is heard instead). */
export function cutWhenLonger(el: HTMLElement, growing = false) {
  sized.observe(el);
  if (growing) new MutationObserver(() => measure(el)).observe(el, {childList: true, subtree: true, characterData: true});
}
