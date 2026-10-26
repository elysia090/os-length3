import {bytes, h} from '../../ui/dom.ts';
import {t, tn} from '../../i18n.ts';
import * as dotfiles from '../../home/dotfiles.ts';
import {askFoot, SETTLE} from '../common.ts';
import {allSessions, type Session} from '../bench/terminal.ts';
import {errorText} from '../../app/errors.ts';
import {button} from './parts.ts';

// Runtime's Dotfiles: what every Prompt starts with in /root, in one box, a row each, the one open lit with its text
// under it there.

const running = () => allSessions().filter(([, s]) => s.running);

/** What a dotfile's box asks of the Dotfiles around it: the rows drawn again (`open`, `saved` just now), and a Prompt started again. */
interface BoxWays { paint(open?: string | null, saved?: boolean): void; restarted(): void }

/**
 * Dotfiles: one box, a row each (name, size), and New dotfile at its foot;
 * a row pressed opens its text under it, in the box, and pressed again (or
 * Close) folds it. Every Prompt starts with them in /root, and the Remote
 * keeps them in step across devices. A Prompt already running has what it
 * started with (its shell has read them, and its /root is its own), so a
 * save says so under the box, with Start again; Remove asks in the box
 * first, since it goes from every device.
 */
export function dotfilesSection(restarted: () => void, counted: (n: number) => void = () => {}): HTMLElement {
  const section = h('section', {class: 'section dotfiles-part', 'aria-label': t('Dotfiles')});
  const w: BoxWays = {paint: (open, saved) => paint(open, saved), restarted};
  /** The rows drawn: `open`'s text under it (`saved` just now), or a new one's (`fresh`, the name it is offered with) under New dotfile. */
  const paint = (open: string | null = null, saved = false, fresh: string | null = null) => {
    const all = dotfiles.read();
    const names = Object.keys(all).sort();
    const pressed = section.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.name : undefined;
    const list = h('div', {class: 'dot-list'});
    for (const n of names) {
      list.append(fileRow(n, all[n], n === open, () => paint(n === open ? null : n)));
      if (n === open) list.append(editBox(n, all[n], false, saved, w));
    }
    const make = h('button', {type: 'button', class: `dot-row new${fresh ? ' current' : ''}`, 'aria-expanded': String(!!fresh), 'data-name': ''},
      '+', h('span', {}, t('New dotfile')));
    make.addEventListener('click', () => paint(null, false, fresh ? null : [...dotfiles.COMMON, '.config'].find((c) => !(c in all)) ?? ''));
    list.append(make);
    if (fresh) list.append(editBox(fresh, '', true, false, w));
    counted(names.length);
    section.replaceChildren(list);
    // The keyboard stays on the row it pressed; a new one's name is chosen, to be written over.
    if (fresh) section.querySelector<HTMLInputElement>('.dot-name')?.select();
    else if (pressed !== undefined) section.querySelector<HTMLElement>(`.dot-row[data-name="${CSS.escape(pressed)}"]`)?.focus();
  };
  paint();
  return section;
}

/** A dotfile's row: its name and size; pressed, it opens (or folds, `current`). */
function fileRow(name: string, text: string, current: boolean, press: () => void): HTMLElement {
  const row = h('button', {type: 'button', class: `dot-row${current ? ' current' : ''}`, 'aria-expanded': String(current), 'data-name': name},
    h('span', {class: 'dot-row-name'}, name), h('span', {class: 'muted small'}, bytes(new TextEncoder().encode(text).length)));
  row.addEventListener('click', press);
  return row;
}

/** The file's text in a box like Forge's, its name above (editable when new, `fresh`), Save and Remove; `saved`, just now. */
function editBox(name: string, text: string, fresh: boolean, saved: boolean, w: BoxWays): HTMLElement {
  const error = h('p', {class: 'error', role: 'alert'});
  const title = h('input', {class: 'line-in mono dot-name', value: name, 'aria-label': t('Name'), spellcheck: 'false'}) as HTMLInputElement;
  title.disabled = !fresh;
  const body = h('textarea', {class: 'line-in mono dot-text', rows: '12', spellcheck: 'false', 'aria-label': name}) as HTMLTextAreaElement;
  body.value = text;
  const save = button(t('Save'), 'primary');
  save.addEventListener('click', async () => {
    const n = title.value.trim();
    // A new one named as one there is would take its place unasked: the name is to change, as New repo's is.
    if (fresh && n in dotfiles.read()) { error.textContent = t('There is a dotfile named {name} already', {name: n}); title.focus(); return; }
    try { await dotfiles.save(n, body.value); } catch (e) { error.textContent = errorText(e); return; }
    w.paint(n, true);
  });
  const remove = button(t('Remove'));
  remove.hidden = fresh;
  const close = button(t('Close'));
  close.addEventListener('click', () => w.paint());
  const acts = h('div', {class: 'row work-act'}, remove, h('span', {class: 'grow'}), close, save);
  const box = h('div', {class: 'dot-editor'}, h('div', {class: 'row dot-head'}, h('span', {class: 'muted mono'}, '/root/'), title), body, error, acts);
  remove.addEventListener('click', () => askRemove(name, box, acts, remove, error, w));
  // Saved while Prompts run: they have what they started with until they start again. Under the box, so Save stays put.
  const now = saved ? running() : [];
  if (now.length) box.append(startAgain(now, w));
  return box;
}

/** Asked in the box, where its deeds were: it goes from every device. Remove stays under the pointer, Not now at the right. */
function askRemove(name: string, box: HTMLElement, acts: HTMLElement, remove: HTMLButtonElement, error: HTMLElement, w: BoxWays) {
  const foot = askFoot(remove, box);
  const no = button(t('Not now')), yes = button(t('Remove'), 'primary');
  const ask = h('div', {class: 'dot-ask', role: 'group', 'aria-label': t('Remove {name}', {name})},
    h('p', {class: 'muted small'}, t('{name} goes from every device.', {name})),
    running().length ? h('p', {class: 'muted small'}, t('Prompts running keep it until they start again.')) : null,
    foot(no, yes));
  no.addEventListener('click', () => { ask.replaceWith(acts); remove.focus(); });
  const shown = performance.now();
  yes.addEventListener('click', async () => {
    if (performance.now() - shown < SETTLE) return;
    yes.disabled = true;
    try { await dotfiles.remove(name); w.paint(); } catch (e) { error.textContent = errorText(e); yes.disabled = false; }
  });
  acts.replaceWith(ask);
  yes.focus();
}

/** Saved while the Prompts `now` run: which get it when they start again, and Start again. */
function startAgain(now: [string, Session][], w: BoxWays): HTMLElement {
  const again = button(t('Start again'));
  const note = h('p', {class: 'muted small dot-note', role: 'status'},
    tn('The Prompt in {list} gets it when it starts again', 'The Prompts in {list} get it when they start again', now.length, {list: now.map(([repo]) => repo).join(', ')}), ' ', again);
  again.addEventListener('click', () => { for (const [, s] of running()) s.restart(); note.remove(); w.restarted(); });
  return note;
}
