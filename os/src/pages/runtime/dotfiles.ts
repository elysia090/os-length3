import {bytes, h} from '../../ui/dom.ts';
import {t, tn} from '../../i18n.ts';
import * as dotfiles from '../../home/dotfiles.ts';
import {askFoot, SETTLE} from '../common.ts';
import {allSessions} from '../bench/terminal.ts';
import {button, card, message} from './parts.ts';

// Runtime's Dotfiles: what every Prompt starts with in /root, a card each, and one open to edit under them.

/**
 * Dotfiles: a small card each (name, size), a dashed one to make another;
 * a card opens its text under them to edit. Every Prompt starts with them
 * in /root, and the Remote keeps them in step across devices. A Prompt
 * already running has what it started with (its shell has read them, and
 * its /root is its own), so a save says so under the box, with Start again;
 * Remove asks in the box first, since it goes from every device.
 */
export function dotfilesSection(restarted: () => void, counted: (n: number) => void = () => {}): HTMLElement {
  const section = h('section', {class: 'section dotfiles-part', 'aria-label': t('Dotfiles')});
  const editor = h('div', {});
  const running = () => allSessions().filter(([, s]) => s.running);
  const paint = (open: string | null = null, saved = false) => {
    const all = dotfiles.read();
    const names = Object.keys(all).sort();
    const cards = names.map((n) => {
      const c = card(n, [bytes(new TextEncoder().encode(all[n]).length)], null, `mono-title openable${n === open ? ' current' : ''}`);
      c.tabIndex = 0;
      c.setAttribute('role', 'button');
      c.addEventListener('click', () => paint(n));
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter') paint(n); });
      return c;
    });
    const make = h('button', {type: 'button', class: 'card small-card new'}, '+', h('span', {}, t('New dotfile')));
    make.addEventListener('click', () => {
      const name = dotfiles.COMMON.find((c) => !(c in all)) ?? '.config';
      editor.replaceChildren(edit(name, '', true));
      editor.querySelector<HTMLInputElement>('input')?.select();
    });
    counted(names.length);
    section.replaceChildren(h('div', {class: 'grid small-grid'}, ...cards, make), editor);
    editor.replaceChildren(...(open && open in all ? [edit(open, all[open], false, saved)] : []));
  };
  // The file's text in a box like Forge's, its name above (editable when new), Save and Remove.
  const edit = (name: string, text: string, fresh: boolean, saved = false): HTMLElement => {
    const error = h('p', {class: 'error', role: 'alert'});
    const title = h('input', {class: 'line-in mono dot-name', value: name, 'aria-label': t('Name'), spellcheck: 'false'}) as HTMLInputElement;
    title.disabled = !fresh;
    const body = h('textarea', {class: 'line-in mono dot-text', rows: '12', spellcheck: 'false', 'aria-label': name}) as HTMLTextAreaElement;
    body.value = text;
    const save = button(t('Save'), 'primary');
    save.addEventListener('click', async () => {
      const n = title.value.trim();
      try { await dotfiles.save(n, body.value); } catch (e) { error.textContent = message(e); return; }
      paint(n, true);
    });
    const remove = button(t('Remove'));
    remove.hidden = fresh;
    const close = button(t('Close'));
    close.addEventListener('click', () => paint());
    const acts = h('div', {class: 'row work-act'}, remove, h('span', {class: 'grow'}), close, save);
    const box = h('div', {class: 'dot-editor'}, h('div', {class: 'row dot-head'}, h('span', {class: 'muted mono'}, '/root/'), title), body, error, acts);
    // Asked in the box, where its deeds were: it goes from every device. Remove stays under the pointer, Not now at the right.
    remove.addEventListener('click', () => {
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
        try { await dotfiles.remove(name); paint(); } catch (e) { error.textContent = message(e); yes.disabled = false; }
      });
      acts.replaceWith(ask);
      yes.focus();
    });
    // Saved while Prompts run: they have what they started with until they start again. Under the box, so Save stays put.
    const now = saved ? running() : [];
    if (now.length) {
      const again = button(t('Start again'));
      again.addEventListener('click', () => { for (const [, s] of running()) s.restart(); note.remove(); restarted(); });
      const note = h('p', {class: 'muted small dot-note', role: 'status'},
        tn('The Prompt in {list} gets it when it starts again', 'The Prompts in {list} get it when they start again', now.length, {list: now.map(([repo]) => repo).join(', ')}), ' ', again);
      box.append(note);
    }
    return box;
  };
  paint();
  return section;
}
