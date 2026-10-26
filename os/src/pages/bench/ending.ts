import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {LAND, paced, still} from '../../ui/glide.ts';

// How a Prompt is seen to be cut and to end (terminal.ts): a run interrupted jolts the screen; ended, the Prompt says
// how at the foot of its output beside its power switch, off, and goes dark as a tube switched off does; started
// again, the new one is switched on in its place.

/** The screen jolts as a run is cut, at once (it answers the hand). */
export function jolt(term: HTMLElement, out: HTMLElement) {
  // By its place (left, never a layer of its own, which would come over what stands on it) and, on the screen, the
  // light of its words.
  const lit = term.closest('.screen') ? '0 0 10px var(--done), 0 0 2px var(--add-tint)' : null;
  if (!still()) out.animate([{left: '0px'}, {left: '4px', ...lit && {textShadow: lit}, offset: .12}, {left: '-3px', offset: .3},
    {left: '1px', offset: .55}, {left: '0px'}], {duration: 280, easing: 'ease-out'});
}

/**
 * How it ended (`said`; `why` its title, when it did not start) and its power switch, off, which `restart` hears
 * switched on.
 */
export function endLine(said: string, why: string, restart: () => void): {line: HTMLElement; power: HTMLElement} {
  // Ended: what happened and, at the Prompt's bottom right under its output, its power switch, off: switched on,
  // it starts again (styles.css). The same switch as SSH's and a repo card's, no taller than the line.
  const power = h('button', {class: 'power', type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': t('Start again')}, h('span', {class: 'knob'}));
  power.addEventListener('click', restart);
  // The last thing on its thread, under what it printed last: how it ended, and the switch beside it (in the pane a
  // dot of its own, off), not a row of its own over the box's Run.
  const line = h('div', {class: 'term-end'}, h('span', why ? {title: why} : {}, said), power);
  return {line, power};
}

/** Ending as it is seen: the switch goes over to off, and the screen (`out`) goes dark. */
export function goDark(power: HTMLElement, out: HTMLElement) {
  // From on, its knob across and the green going from under it; the output flares as a tube does and dims to its
  // rest (styles.css .term.ended).
  power.animate([{backgroundColor: 'var(--raised)', borderColor: 'var(--edge)'}, {}], {duration: paced(260), easing: 'ease-out'});
  power.firstElementChild!.animate([{transform: 'translateX(24px)', backgroundColor: 'var(--done)'}, {}], {duration: paced(280), easing: LAND});
  out.animate([{filter: 'brightness(1.8)'}, {filter: 'brightness(.5)', offset: .3}, {}], {duration: paced(460), easing: 'ease-out'});
}

/** `next` in the place of `old` (a new shell for the same repo), switched on as a tube is; `told` once it stands there. */
export function switchOver(old: HTMLElement, next: HTMLElement, told: () => void) {
  const box = old.parentElement;
  const swap = () => {
    const was = box?.getBoundingClientRect().height ?? 0;
    if (old.isConnected) old.replaceWith(next);
    told();
    if (still() || !box || !next.isConnected) return;
    // Switched on, as a tube is: the box goes from the old screen's height to the new one's, and the new one opens
    // out of a bright line across its middle.
    const now = box.getBoundingClientRect().height;
    if (Math.abs(now - was) > 1) box.animate([{height: `${was}px`}, {height: `${now}px`}], {duration: paced(300), easing: LAND});
    next.animate([{scale: '1 .02', filter: 'brightness(2.6)', opacity: .85}, {scale: '1 .02', filter: 'brightness(2.6)', offset: .22},
      {scale: '1 1', filter: 'brightness(1)', opacity: 1}], {duration: paced(300), easing: LAND});
  };
  if (still() || !old.isConnected) { swap(); return; }
  // The old one goes first, as a tube switched off does: down to a bright line across its middle.
  old.animate([{scale: '1 1', filter: 'brightness(1)'}, {scale: '1 .02', filter: 'brightness(2.4)'}],
    {duration: paced(140), easing: 'cubic-bezier(.5, 0, .9, .5)', fill: 'forwards'}).finished.then(swap, swap);
}
