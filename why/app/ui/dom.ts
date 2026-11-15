// Element construction. Text is always set as text, never parsed as HTML.

type Child = Node | string | null | undefined | false;

export function h(tag: string, props: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    // A style goes through the style object, never as an attribute: the desktop app's policy (style-src 'self')
    // drops a style attribute written into the page, and with it a row's depth or a slide's place.
    if (k === 'class') el.className = v; else if (k === 'style') el.style.cssText = v; else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

/**
 * The arrow keys go along a list of things pressed (`items` in `list`), as they go along the rail: from the one with
 * the keyboard to the nearest one that way on the screen (a column of rows, a row of pills, a grid of cards alike).
 * Tab still goes through them all; nothing else changes.
 */
export function arrowKeys(list: HTMLElement, items: string) {
  list.addEventListener('keydown', (event) => {
    const way = ({ArrowDown: [0, 1], ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowLeft: [-1, 0]} as Record<string, [number, number]>)[event.key];
    if (!way || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const at = (event.target as Element).closest<HTMLElement>(items);
    if (!at || !list.contains(at) || (event.target as Element).matches('input, textarea, select, [contenteditable]')) return;
    const from = at.getBoundingClientRect(), cx = from.left + from.width / 2, cy = from.top + from.height / 2;
    let best: HTMLElement | null = null, bestCost = Infinity;
    for (const el of list.querySelectorAll<HTMLElement>(items)) {
      if (el === at || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect(), dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy;
      // Only what lies that way, the one most in line with it first, then the nearest.
      const ahead = way[0] ? dx * way[0] : dy * way[1];
      if (ahead <= 1) continue;
      const aside = Math.abs(way[0] ? dy : dx);
      const cost = ahead + aside * 3;
      if (cost < bestCost) { bestCost = cost; best = el; }
    }
    if (!best) return;
    event.preventDefault();
    best.focus();
  });
}
