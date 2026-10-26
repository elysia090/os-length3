import {h} from '../../ui/dom.ts';
import {glide, where} from '../../ui/glide.ts';
import {t} from '../../i18n.ts';

// Git's repo chips: one row that slides sideways, however many repos there are, so they never push the issues down.
// The one chosen holds the ink, and is kept in view as the row slides.

/** The chips drawn again: one for each of `names` ('' is All), `chosen` holding the ink; `choose` hears one pressed. */
export function paintChips(chips: HTMLElement, names: readonly string[], chosen: string, choose: (name: string, e: MouseEvent) => void) {
  // A chip pressed from the keyboard keeps it when the row is drawn again.
  const had = [...chips.children].indexOf(document.activeElement as Element);
  const inkWas = where(chips.querySelector('[aria-checked="true"]'));
  chips.replaceChildren(...names.map((r) => {
    const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(chosen === r)}, r || t('All'));
    b.addEventListener('click', (e) => choose(r, e));
    return b;
  }));
  // The ink goes from the chip it was on to the one chosen, as along the rail and the band.
  glide(inkWas, chips.querySelector<HTMLElement>('[aria-checked="true"]'), chips, 'var(--r-round)');
  if (had >= 0) (chips.children[had] as HTMLElement | undefined)?.focus({preventScroll: true});
  keepInView(chips);
}

/** The chosen one is kept in view as the row slides. */
function keepInView(chips: HTMLElement) {
  const on = chips.querySelector<HTMLElement>('[aria-checked="true"]');
  if (!on || chips.scrollWidth <= chips.clientWidth) return;
  if (on.offsetLeft < chips.scrollLeft) chips.scrollLeft = on.offsetLeft;
  else if (on.offsetLeft + on.offsetWidth > chips.scrollLeft + chips.clientWidth) chips.scrollLeft = on.offsetLeft + on.offsetWidth - chips.clientWidth;
}
