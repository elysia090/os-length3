import {h} from '../ui/dom.ts';
import {errorText} from '../app/errors.ts';
import {t} from '../i18n.ts';
import {mark} from '../ui/icons.ts';
import {answers, askFoot, SETTLE} from './common.ts';
import {keepOut, nudge, putAway} from '../ui/glide.ts';
import {store, validName} from '../repos/repos.ts';
import {forget, remoteAll, remoteOnly, repoState} from '../remote/lifecycle.ts';
import {connection} from '../remote/connection.ts';
import {promptHolds, stopPrompt} from './bench/terminal.ts';
import {openRepoPlace} from './remote/repos.ts';
import {askFirst} from './remote/repo-off.ts';
import type {Context} from './context.ts';

// A repo's gear, the same in every list of repos (Home's cards, Runtime's
// three columns): near a repo (the pointer on it, or the keyboard in it) a
// small gear shows at its edge; pressed, it offers what is done to the repo
// itself from a list, each chosen on its own and never one after the other:
//
//   Show on the Remote     signed in: its card there (its switch, who sees
//                          it), lit
//   Rename                 a repo on this device alone (one on the Remote is
//                          known there by its name, and keeps it)
//   Free from this device  the copy here goes; it stays on the Remote and
//                          comes back when opened (space.ts free: what the
//                          Remote lacks is sent first, as ever)
//   Delete                 it goes: from this device, and from the Remote
//                          too, where it is turned off and kept 30 days;
//                          there, asked as turning it off is (repo-off.ts)
//
// A deed that cannot be done now is there, not pressable, with why under it.
// Pressed, each becomes its field or its ask in its row, saying what it does,
// before anything is done; a Prompt with nothing running in it does not hold
// the repo back: it is stopped first, and the ask says so. Showing the gear,
// or its list, does nothing; Escape or a press outside puts the list away,
// and nothing has changed. The repo's body (not the gear) opens it in Forge
// (repo-list.ts, runtime/device.ts).

interface GearWays {
  /** Why it cannot be freed from this device now, or null when it can (read when the list opens). */
  why(): Promise<string | null>;
  /** Free it from this device (refused: why, said in the ask). */
  free(): Promise<void>;
  /** Freed, renamed or deleted, once the list is put away: the place draws itself again and shows what it came to. */
  freed(): void;
}

let open: (() => void) | null = null;

const item = (label: string) => h('button', {type: 'button', class: 'pop-item', role: 'menuitem'}, label) as HTMLButtonElement;
const note = (text: string) => h('p', {class: 'muted small pop-note'}, text);
/** What a Prompt with nothing running in it comes to, said in the ask of a deed that lets its repo go. */
const stopsFirst = () => h('p', {class: 'muted small'}, t('Its Prompt is stopped first: nothing is running in it.'));

/**
 * The gear of `repo` and its list. A card holds both at its top right, the list over the card; a row (Runtime's,
 * in a column that scrolls) has the gear in the row and the list under it, in the row's own place. `here`: whether a
 * copy of it is on this device (false: only on the Remote).
 */
export function repoGear(ctx: Context, repo: string, w: GearWays, here = true): {gear: HTMLButtonElement; list: HTMLElement} {
  const gear = h('button', {type: 'button', class: 'repo-gear-button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    'aria-label': t('What to do with {name}', {name: repo}), title: t('What to do with {name}', {name: repo})}, mark('gear')) as HTMLButtonElement;
  const list = h('div', {class: 'pop repo-gear-pop', role: 'menu', 'aria-label': t('What to do with {name}', {name: repo}), hidden: ''});

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
  /** Done (renamed, freed, deleted): the list is put away and the place drawn again as it is now. */
  const done = () => { show(false); w.freed(); };

  const fill = () => {
    list.style.minHeight = '';
    const signedIn = !!connection();
    // On the Remote: as the Remote last listed it, or agreed with this device since (the list is read again only now and then).
    const listed = remoteAll().find((r) => r.name === repo);
    const state = repoState(repo);
    const there = signedIn && (listed || !here || state?.agreed) ? {offAt: listed?.offAt ?? (state?.where === 'off' ? 1 : null)} : null;
    // What a Prompt running here holds back: one with something running in it, everything; one waiting, nothing.
    const holds = promptHolds(repo);
    const busy = holds === 'busy' ? t('Something is running in its Prompt') : null;
    const rows: HTMLElement[] = [];
    if (signedIn) {
      const place = item(t('Show on the Remote'));
      place.addEventListener('click', () => { show(false); openRepoPlace(ctx, repo); });
      rows.push(place);
    }
    const rename = item(t('Rename'));
    const notRenamed = !here ? t('It is only on the Remote: nothing of it is here to rename')
      : there ? t('The Remote knows it by this name, so it keeps it') : null;
    rename.disabled = !!notRenamed || !!busy;
    rename.addEventListener('click', () => renameIn(rename, holds === 'idle'));
    rows.push(rename, ...(notRenamed ? [note(notRenamed)] : []));
    const free = item(t('Free from this device'));
    free.disabled = true;
    const why = note(t('Reading…'));
    why.setAttribute('role', 'status');
    rows.push(free, why);
    const del = item(t('Delete'));
    del.disabled = !!busy;
    del.addEventListener('click', () => (there ? askRemote(del, there.offAt ? 'discard' : 'delete', holds === 'idle') : askHere(del, holds === 'idle')));
    rows.push(del, ...(busy ? [note(busy)] : []));
    list.replaceChildren(...rows);
    rows[0].focus();
    void w.why().then((no) => {
      if (!list.contains(free)) return;
      // Its Prompt waiting is no reason to keep it: it is stopped first, and the ask says so.
      if (no === t('A Prompt has it open') && holds === 'idle') no = null;
      free.disabled = !!no;
      // Why it stays is said under it; when it can go, nothing is said until it is pressed.
      if (no) why.textContent = no; else why.remove();
    }, (e) => { why.textContent = errorText(e); });
    free.addEventListener('click', () => askFree(free, why, holds === 'idle'));
  };

  /**
   * Free, asked in its row in the list, what it does first: the copy here goes, the Remote keeps it. Free under the
   * pointer; Not now puts the row back. Freed, the list is put away and the place hears it.
   */
  const askFree = (free: HTMLButtonElement, why: HTMLElement, stops: boolean) => {
    const foot = askFoot(free, list);
    const no = h('button', {type: 'button', class: 'button small-button'}, t('Not now')) as HTMLButtonElement;
    const yes = h('button', {type: 'button', class: 'button small-button primary'}, t('Free')) as HTMLButtonElement;
    const error = h('p', {class: 'error small', role: 'alert'});
    const ask = h('div', {class: 'pop-ask', role: 'group', 'aria-label': t('Free {repo} from this device', {repo})},
      h('p', {class: 'muted small'}, t('{repo} leaves this device.', {repo})),
      h('p', {class: 'muted small'}, t('It stays on the Remote and comes back when opened.')), stops ? stopsFirst() : null, error, foot(no, yes));
    no.addEventListener('click', () => { ask.replaceWith(free); why.remove(); free.focus(); });
    const shown = performance.now();
    yes.addEventListener('click', async () => {
      if (performance.now() - shown < SETTLE) return;
      yes.disabled = no.disabled = true;
      try {
        if (stops) await stopPrompt(repo);
        await w.free();
        done();
      } catch (e) { error.textContent = errorText(e); yes.disabled = no.disabled = false; }
    });
    free.replaceWith(ask);
    why.remove();
    yes.focus();
  };

  /**
   * Rename, a name written in its row: Rename or Enter gives it, Not now (or Escape) puts the row back. A name it cannot
   * be, or one taken (here or on the Remote), is said under it and keeps the keyboard in it.
   */
  const renameIn = (rename: HTMLButtonElement, stops: boolean) => {
    const input = h('input', {class: 'line-in mono', 'aria-label': t('New name'), placeholder: t('New name'), autocapitalize: 'off', spellcheck: 'false', maxlength: '64'}) as HTMLInputElement;
    input.value = repo;
    const error = h('p', {class: 'error small', role: 'alert'});
    const no = h('button', {type: 'button', class: 'button small-button'}, t('Not now')) as HTMLButtonElement;
    const yes = h('button', {type: 'button', class: 'button small-button primary'}, t('Rename')) as HTMLButtonElement;
    const box = h('div', {class: 'pop-field', role: 'group', 'aria-label': t('Rename {repo}', {repo})}, input, stops ? stopsFirst() : null, error, answers(no, yes));
    const refuse = (why: string) => { error.textContent = why; input.focus(); nudge(input); };
    const give = async () => {
      const to = input.value.trim();
      if (input.disabled) return;
      if (to === repo) { done(); return; }
      if (!validName(to)) { refuse(t('Use letters, digits and . _ -, and do not start with .')); return; }
      if ((await store.list()).some((r) => r.name === to) || remoteOnly().some((r) => r.name === to)) { refuse(t('There is a repo named {name} already', {name: to})); return; }
      input.disabled = yes.disabled = no.disabled = true;
      try {
        if (stops) await stopPrompt(repo, true);
        await store.renameRepo(repo, to, promptHolds(repo) ? [repo] : []);
        forget(repo);
        done();
      } catch (e) { input.disabled = yes.disabled = no.disabled = false; refuse(errorText(e)); }
    };
    input.addEventListener('input', () => { error.textContent = ''; });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      void give();
    });
    yes.addEventListener('click', () => void give());
    no.addEventListener('click', () => { box.replaceWith(rename); rename.focus(); });
    rename.replaceWith(box);
    input.focus();
    input.select();
  };

  /** Delete of a repo no Remote has: asked in its row, as File's Delete is; it goes from here, and nothing has it after. */
  const askHere = (del: HTMLButtonElement, stops: boolean) => {
    const foot = askFoot(del, list);
    const no = h('button', {type: 'button', class: 'button small-button'}, t('Not now')) as HTMLButtonElement;
    const yes = h('button', {type: 'button', class: 'button small-button primary'}, t('Delete')) as HTMLButtonElement;
    const error = h('p', {class: 'error small', role: 'alert'});
    const ask = h('div', {class: 'pop-ask', role: 'group', 'aria-label': t('Delete {repo}', {repo})},
      h('p', {class: 'muted small'}, t('{repo} goes from this device, with everything in it.', {repo})),
      h('p', {class: 'muted small'}, t('It is kept nowhere else, so it cannot be brought back.')), stops ? stopsFirst() : null, error, foot(no, yes));
    no.addEventListener('click', () => { ask.replaceWith(del); del.focus(); });
    const shown = performance.now();
    yes.addEventListener('click', async () => {
      if (performance.now() - shown < SETTLE) return;
      yes.disabled = no.disabled = true;
      try {
        await deleteHere(stops);
        done();
      } catch (e) { error.textContent = errorText(e); yes.disabled = no.disabled = false; }
    });
    del.replaceWith(ask);
    yes.focus();
  };

  /** The copy here, and everything this device keeps of the repo, gone (its Prompt, waiting, stopped first). */
  const deleteHere = async (stops: boolean) => {
    if (stops) await stopPrompt(repo, true);
    await store.deleteRepo(repo, promptHolds(repo) ? [repo] : []);
    forget(repo);
  };

  /**
   * Delete of a repo the Remote has: asked in the list as turning it off is asked on its card (the account's name, the
   * repo's, the code, a passkey), since it guards the repo's history against another hand. On, it is turned off (the
   * Remote keeps it 30 days) and the copy here goes; off already, it is discarded there for good.
   */
  const askRemote = (del: HTMLButtonElement, kind: 'delete' | 'discard', stops: boolean) => {
    const end = () => { done(); return Promise.resolve(); };
    askFirst(list, del, repo, kind, here, {done: end, ended: end, keyed: () => {}}, async () => { if (here) await deleteHere(stops); });
  };

  gear.addEventListener('click', (e) => { e.stopPropagation(); show(gear.getAttribute('aria-expanded') !== 'true'); });
  // Inside a card that is pressed as a whole, the gear and its list are the gear's own.
  list.addEventListener('click', (e) => e.stopPropagation());
  return {gear, list};
}
