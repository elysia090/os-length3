import {h} from '../../ui/dom.ts';
import {mark} from '../../ui/icons.ts';
import {t} from '../../i18n.ts';
import * as servers from '../../remote/servers.ts';
import {keepOut, putAway} from '../../ui/glide.ts';
import {errorText} from '../../app/errors.ts';
import {pressing} from './parts.ts';

// A repo card's Share: which servers it is shown in, chosen from a list over the card.

/**
 * Share: as the language is chosen in the person's menu, it opens into a
 * list over the card, one row per server one is in, the ones the repo is
 * shown in bold; pressing one shows it there or takes it off at once, and
 * the list stays open for the next. It goes on a press outside, Escape or
 * Share again. Going public is the server's (its gear); it stays as it is here.
 */
export function sharing(now: servers.RepoSeen, error: HTMLElement): HTMLElement {
  const open = h('button', {type: 'button', class: 'button small-button share-open', 'aria-haspopup': 'true', 'aria-expanded': 'false'},
    h('span', {}, t('Share')), mark('down')) as HTMLButtonElement;
  const list = h('div', {class: 'pop share-pop', role: 'menu', 'aria-label': t('Share'), hidden: ''});
  let shared = new Set(now.servers.map((x) => x.id));
  /** Shown in server `id`, or taken off it: whether it is shown there now. */
  const toggle = async (id: string) => {
    const next = new Set(shared);
    if (next.has(id)) next.delete(id); else next.add(id);
    now = await seenIn(now, [...next]);
    shared = next;
    return shared.has(id);
  };
  const holder = h('span', {class: 'share'}, open, list);
  const away = (e: Event) => {
    if (e instanceof KeyboardEvent ? e.key === 'Escape' : !holder.contains(e.target as Node)) { show(false); if (e instanceof KeyboardEvent) open.focus(); }
  };
  const show = (out: boolean) => {
    if (out) { keepOut(list); list.hidden = false; } else putAway(list, () => { list.hidden = true; });
    open.setAttribute('aria-expanded', String(out));
    for (const k of ['pointerdown', 'keydown'] as const) (out ? document.addEventListener : document.removeEventListener).call(document, k, away);
  };
  open.addEventListener('click', async (event) => {
    if (open.getAttribute('aria-expanded') === 'true') { show(false); return; }
    show(true);
    await fill(list, error, (id) => shared.has(id), toggle);
    // Opened from the keyboard, the keyboard goes in with it.
    if (event.detail === 0) list.querySelector<HTMLElement>('.pop-item')?.focus();
  });
  list.addEventListener('keydown', (event) => along(list, event));
  return holder;
}

/** The repo `now` is, shown in the servers `ids` from now on. */
function seenIn(now: servers.RepoSeen, ids: string[]): Promise<servers.RepoSeen> {
  // Public as a server it leaves: no longer public. Public otherwise: kept, with the new list.
  return now.seen === 'everyone' && !(now.asServer && !ids.includes(now.asServer))
    ? servers.setSeen(now.name, 'everyone', {servers: ids, as: now.asServer ?? 'me'})
    : servers.setSeen(now.name, ids.length ? 'servers' : 'private', ids.length ? {servers: ids} : {});
}

/** The list: a row per server one is in, checked where it is shown (`shown`); pressed, `toggle` it there. */
async function fill(list: HTMLElement, error: HTMLElement, shown: (id: string) => boolean, toggle: (id: string) => Promise<boolean>) {
  let mine: servers.Server[];
  // Not read (away): said in the list, and read again the next time it opens.
  try { mine = await servers.servers(); } catch (e) { list.replaceChildren(h('p', {class: 'error small pop-note'}, errorText(e))); return; }
  const rows = mine.map((s) => {
    const b = h('button', {type: 'button', class: 'pop-item', role: 'menuitemcheckbox', 'aria-checked': String(shown(s.id))}, s.name) as HTMLButtonElement;
    b.addEventListener('click', () => void pressing(b, error, async () => { b.setAttribute('aria-checked', String(await toggle(s.id))); }));
    return b;
  });
  list.replaceChildren(h('div', {class: 'pop-group', role: 'group', 'aria-label': t('Shown in')},
    h('div', {class: 'pop-head muted small'}, t('Shown in')), ...(rows.length ? rows : [h('p', {class: 'muted small pop-note'}, t('In no server yet'))])));
}

/** ↓ and ↑ along the list's rows, round at its ends. */
function along(list: HTMLElement, event: KeyboardEvent) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const items = [...list.querySelectorAll<HTMLElement>('.pop-item:not([disabled])')];
  if (!items.length) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLElement);
  items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
}
