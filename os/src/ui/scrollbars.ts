// A box's scrollbar is there while it is scrolled, and a moment after, as a phone's and a Mac's are (base.css
// .scrolling): at rest a long box carries no line of its own beside what it holds (two files side by side were each
// edged with one, a dark bar with arrows on Windows). Its room stays, so nothing moves as it comes and goes; dragged,
// it is scrolling, so it stays while the hand is on it.

const LINGER = 900;

/** Each box (the page too) shows its bar as it scrolls, its own only (a box inside it keeps its own at rest). */
export function scrollbars() {
  const resting = new WeakMap<Element, number>();
  addEventListener('scroll', (event) => {
    const el = event.target === document ? document.documentElement : event.target;
    if (!(el instanceof Element)) return;
    el.classList.add('scrolling');
    clearTimeout(resting.get(el));
    resting.set(el, window.setTimeout(() => el.classList.remove('scrolling'), LINGER));
  }, {capture: true, passive: true});
}
