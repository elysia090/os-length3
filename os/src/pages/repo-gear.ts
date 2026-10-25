import {h} from '../ui/dom.ts';
import {errorText} from '../app/errors.ts';
import {t} from '../i18n.ts';
import {mark} from '../ui/icons.ts';
import {askFoot, SETTLE} from './common.ts';
import {keepOut, putAway} from '../ui/glide.ts';

// A repo's gear, the same in every list of repos (Home's cards, Runtime's
// three columns): near a repo (the pointer on it, or the keyboard in it) a
// small gear shows at its edge; pressed, it offers the two things one does to
// the repo from a list, each chosen on its own and never one after the other:
//
//   Open in Forge          work on it
//   Free from this device  the copy here goes; it stays on the Remote and
//                          comes back when opened (space.ts free: what the
//                          Remote lacks is sent first, as ever)
//
// Free that cannot be done now is there, not pressable, with why under it.
// Pressed, it asks in its row, saying what it does, before anything goes.
// Showing the gear, or its list, does nothing; Escape or a press outside puts
// the list away, and nothing has changed. The repo's body (not the gear) is
// the repo itself, its own place (repo-list.ts, runtime/device.ts).

export interface GearWays {
  /** Open it in Forge (brought here first when it is only on the Remote). */
  forge(): void | Promise<void>;
  /** Why it cannot be freed from this device now, or null when it can (read when the list opens). */
  why(): Promise<string | null>;
  /** Free it from this device (refused: why, said in the ask). */
  free(): Promise<void>;
  /** Freed, once the list is put away: the place draws itself again and shows what it came to. */
  freed(): void;
}

let open: (() => void) | null = null;

/**
 * The gear of `repo` and its list. A card holds both at its top right, the list over the card; a row (Runtime's,
 * in a column that scrolls) has the gear in the row and the list under it, in the row's own place.
 */
export function repoGear(repo: string, w: GearWays): {gear: HTMLButtonElement; list: HTMLElement} {
  const gear = h('button', {type: 'button', class: 'repo-gear-button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    'aria-label': t('What to do with {name}', {name: repo}), title: t('What to do with {name}', {name: repo})}, mark('gear')) as HTMLButtonElement;
  const list = h('div', {class: 'pop repo-gear-pop', role: 'menu', 'aria-label': t('What to do with {name}', {name: repo}), hidden: ''});
  const item = (label: string) => h('button', {type: 'button', class: 'pop-item', role: 'menuitem'}, label) as HTMLButtonElement;

  const away = (e: Event) => {
    const mine = (n: Node | null) => !!n && (gear.contains(n) || list.contains(n));
    if (e instanceof KeyboardEvent ? e.key !== 'Escape' : mine(e.target as Node)) return;
    const inside = mine(document.activeElement);
    show(false);
    if (e instanceof KeyboardEvent) { e.stopPropagation(); if (inside) gear.focus(); }
  };
  const show = (on: boolean) => {
    if (on) { open?.(); open = () => show(false); } else if (open) open = null;
    if (on) { keepOut(list); list.hidden = false; } else putAway(list, () => { list.hidden = true; });
    gear.setAttribute('aria-expanded', String(on));
    for (const k of ['pointerdown', 'keydown'] as const) (on ? document.addEventListener : document.removeEventListener).call(document, k, away, true);
    if (on) fill();
  };

  const fill = () => {
    const forge = item(t('Open in Forge'));
    forge.addEventListener('click', () => { show(false); void w.forge(); });
    const free = item(t('Free from this device'));
    free.disabled = true;
    const why = h('p', {class: 'muted small pop-note', role: 'status'}, t('Reading…'));
    list.replaceChildren(forge, free, why);
    forge.focus();
    void w.why().then((no) => {
      if (!list.contains(free)) return;
      free.disabled = !!no;
      // Why it stays is said under it; when it can go, nothing is said until it is pressed.
      if (no) why.textContent = no; else why.remove();
    }, (e) => { why.textContent = errorText(e); });
    free.addEventListener('click', () => {
      // Asked in its row, what it does first: the copy here goes, the Remote keeps it. Free under the pointer.
      const foot = askFoot(free, list);
      const no = h('button', {type: 'button', class: 'button small-button'}, t('Not now')) as HTMLButtonElement;
      const yes = h('button', {type: 'button', class: 'button small-button primary'}, t('Free')) as HTMLButtonElement;
      const error = h('p', {class: 'error small', role: 'alert'});
      const ask = h('div', {class: 'pop-ask', role: 'group', 'aria-label': t('Free {repo} from this device', {repo})},
        h('p', {class: 'muted small'}, t('{repo} leaves this device.', {repo})),
        h('p', {class: 'muted small'}, t('It stays on the Remote and comes back when opened.')), error, foot(no, yes));
      no.addEventListener('click', () => { ask.replaceWith(free); why.remove(); free.focus(); });
      const shown = performance.now();
      yes.addEventListener('click', async () => {
        if (performance.now() - shown < SETTLE) return;
        yes.disabled = no.disabled = true;
        try { await w.free(); show(false); w.freed(); } catch (e) { error.textContent = errorText(e); yes.disabled = no.disabled = false; }
      });
      free.replaceWith(ask);
      why.remove();
      yes.focus();
    });
  };

  gear.addEventListener('click', (e) => { e.stopPropagation(); show(gear.getAttribute('aria-expanded') !== 'true'); });
  // Inside a card that is pressed as a whole, the gear and its list are the gear's own.
  list.addEventListener('click', (e) => e.stopPropagation());
  return {gear, list};
}
