import {h} from './dom.ts';

/**
 * The page stepping back out of focus under something laid over it (File's tree, what the band's search found): the
 * same blur over all of it and a thin wash of the ground, and only in a strip at the window's top and at its foot,
 * lower than a place's icon is tall, deeper, as a lens tilted over the page leaves its far edges (styles: .page-veil).
 * So what is dark on the page (the terminal, a sheet's shadow) is no hard shape beside what lies over it. Three layers,
 * each blurring what is under it (never one in another: a blurred thing's children see only itself), put in the page
 * the first time it is out. `under`: what in the window stays in focus over it (styles: 'all' for nothing but the
 * rail, 'band' for the rail and the band's keys).
 */
export function pageVeil(under: 'all' | 'band'): {element: HTMLElement; out(on: boolean): void} {
  const element = h('div', {class: `page-veil under-${under}`, 'aria-hidden': 'true'}, h('i'), h('i'), h('i'));
  return {
    element,
    out(on: boolean) {
      if (on && !element.isConnected) document.body.append(element);
      element.classList.toggle('out', on);
    },
  };
}
