import {h} from './dom.ts';

/**
 * The world stepping back out of focus under something laid over it (File's tree, the person's menu, what the band's
 * search found): the same blur over all of it and a wash of the ground, and only in a strip at the window's top and at
 * its foot, lower than a place's icon is tall, deeper, as a lens tilted over the page leaves its far edges (styles:
 * .page-veil). So what is dark on the page (the terminal, a sheet's shadow) is no hard shape beside what lies over it.
 * Three layers, each blurring what is under it (never one in another: a blurred thing's children see only itself), put
 * in the page the first time it is out. The frame (the rail, the band) is the camera's and never out of focus (DESIGN
 * §2). `wash`: how much of the ground comes over the world: thin under what is small at the window's edge, deep under
 * what is read across the page.
 */
export function pageVeil(wash: 'thin' | 'deep'): {element: HTMLElement; out(on: boolean): void} {
  const element = h('div', {class: `page-veil ${wash}`, 'aria-hidden': 'true'}, h('i'), h('i'), h('i'));
  return {
    element,
    out(on: boolean) {
      if (on && !element.isConnected) document.body.append(element);
      element.classList.toggle('out', on);
    },
  };
}
