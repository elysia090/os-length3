/**
 * A press that just misses what was called up (a menu, File's tree) is still its own: within `by` px outside it, the
 * press neither puts it away nor lands on what is under it (DESIGN §7; the margin a toolkit that copies the phones'
 * manners keeps round a popup, 16 px). `sheet`: what is out, or null; told by where the press was, so nothing is laid
 * round the sheet that could make the page any larger.
 */
export function keepNear(sheet: () => Element | null, by = 16) {
  let swallowed = false;
  document.addEventListener('pointerdown', (e) => {
    swallowed = false;
    const el = sheet();
    if (!el || el.contains(e.target as Node)) return;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right), dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
    if (dx > by || dy > by) return;
    swallowed = true;
    e.stopPropagation();
    e.preventDefault();
  }, true);
  document.addEventListener('click', (e) => {
    if (!swallowed) return;
    swallowed = false;
    e.stopPropagation();
    e.preventDefault();
  }, true);
}
