import {h} from '../dom.ts';
import {t, tn} from '../i18n.ts';
import {LIMITS, initials, normalize, parse, type Profile} from '../profile.ts';
import {connection, rename} from '../remote.ts';
import {getState, setState, settingName, unreadable} from '../state.ts';
import * as servers from '../servers.ts';
import * as inbox from '../inbox.ts';
import {news, onNews} from '../news.ts';
import {store} from '../repos.ts';
import {repoList} from './repo-list.ts';
import {todoBox} from './todo-box.ts';
import {openNext as openConversation} from './inbox.ts';
import {Reference} from './reference.ts';
import type {Context} from './context.ts';
import {onRightPane, pluginArea, rightPaneOpen, setRightPane} from './pane.ts';
import {mark, paneMark} from '../icons.ts';
import {onPlugins, pluginsOpen} from '../plugins.ts';
import {errorText} from '../errors.ts';
import {LAND, nudge, paced, paneOut, pop, still} from '../glide.ts';

let editing = false;
/** The profile's form was opened from elsewhere (the person's menu): Home drawn next gives the opening its beat. */
let opening = false;

/** The profile as it stands (Home's state, see state.ts), for Home and the rail's own icon. */
export const currentProfile = (): Profile => parse(getState('profile'));

/** Open Home with the profile form out. */
export function startEditing(ctx: Context) {
  editing = true;
  opening = true;
  void ctx.go('home').then(() => document.getElementById('profile-name')?.focus());
}

/** Home: a profile that reads the same for its owner and for anyone else. */
export function home(ctx: Context): Node[] {
  const owner = true;
  const count = h('span', {});
  const list = repoList(ctx, {newCard: true, counted: (n) => counting(count, n, 'repo', 'repos')});
  void list.refresh();
  const grid = list.element;
  // About three across at a laptop's width (styles.css): Home's own, so New repo's list and other grids stay as they are.
  grid.classList.add('home-repos');
  const header = profileHeader(count, owner);
  // A setting that could not be read is said here, where the person looks first; it is not written over meanwhile.
  const unread = [...unreadable()].map(([k, why]) => h('p', {class: 'error', role: 'alert'}, t('{what} could not be read ({why})', {what: settingName(k), why})));
  const main = h('div', {class: 'home-main'}, header, ...unread, todoBox(),
    h('section', {class: 'section', 'aria-labelledby': 'repos-title'}, h('h2', {id: 'repos-title'}, t('Repos')), grid),
    h('section', {class: 'section', 'aria-labelledby': 'servers-title'},
      h('h2', {id: 'servers-title'}, t('Servers')), ownServers(ctx)));
  return [homePane(main, ctx)];
}

/**
 * Home with the right pane Forge and Git have, in the same place and put away and brought back by the same switch
 * at its top (one setting for all three): at its top the plugin area (plain until the rail's plug opens it, here
 * as there). It stays where it is while Home scrolls under the rail; put away, Home takes the width.
 */
function homePane(main: HTMLElement, ctx: Context): HTMLElement {
  const side = h('aside', {class: 'home-side', id: 'home-side', 'aria-label': t('Lately')}, pluginArea(), lately(ctx));
  const toggle = h('button', {type: 'button', class: 'pane-toggle', 'aria-label': t('Right pane'), 'aria-controls': 'home-side'}, paneMark()) as HTMLButtonElement;
  // The search Forge and Git have, where theirs is: in the repo last worked in (named in it, there being no band to
  // say which), what is found opened in Forge, at its line.
  let repo = ctx.repo;
  const reference = new Reference({reveal: (path, line, write) => { if (repo) ctx.openRepo(repo, path, write ?? false, undefined, line ?? 0); }});
  const aim = (name: string | null) => { repo = name; reference.setRepo(name); reference.named(name); };
  aim(repo);
  const pane = h('div', {class: 'home-pane'}, h('div', {class: 'home-bar'}, reference.search, toggle), side);
  // None worked in yet (or it is gone): the one changed last, so the box is never there to be pressed for nothing.
  void store.list().then((all) => {
    if (!pane.isConnected || (repo && all.some((r) => r.name === repo))) return;
    aim(all.slice().sort((a, b) => b.modified - a.modified)[0]?.name ?? null);
  }, () => {});
  const layout = h('div', {class: 'home-layout'}, main, pane);
  // What opens under the box is two of the pane wide, as under Forge's (styles.css .search-results).
  new ResizeObserver(() => pane.style.setProperty('--pane-w', `${pane.offsetWidth}px`)).observe(pane);
  // The keys Forge and Git know, here too: Ctrl+K or Ctrl+P (or Ctrl+Shift+F) to the search, the pane brought out for
  // it if it was put away; Ctrl+B to put the pane away or bring it back (⌘ on a Mac).
  const keys = (event: KeyboardEvent) => {
    if (!layout.isConnected) { document.removeEventListener('keydown', keys); return; }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing || document.getElementById('page')?.hasAttribute('inert')) return;
    const k = event.key.toLowerCase();
    if ((k === 'k' || k === 'p') && !event.shiftKey || (k === 'f' && event.shiftKey)) {
      event.preventDefault();
      if (rightPaneOpen()) reference.findNow(); else { setRightPane(true); requestAnimationFrame(() => reference.findNow()); }
    } else if (k === 'b' && !event.shiftKey) { event.preventDefault(); setRightPane(!rightPaneOpen()); }
  };
  document.addEventListener('keydown', keys);
  let was = rightPaneOpen();
  const paint = () => {
    layout.classList.toggle('pane-closed', !rightPaneOpen());
    toggle.setAttribute('aria-expanded', String(rightPaneOpen()));
    if (rightPaneOpen() && !was && layout.isConnected) paneOut(side, toggle);
    was = rightPaneOpen();
  };
  toggle.addEventListener('click', () => setRightPane(!rightPaneOpen()));
  const off = onRightPane(() => { if (!layout.isConnected) { off(); return; } paint(); });
  // The plug opens the plugin area here, and the pane with it.
  const offPlug = onPlugins(() => { if (!layout.isConnected) { offPlug(); return; } if (pluginsOpen()) setRightPane(true); });
  paint();
  return layout;
}

/**
 * What waits since the person was last here, in Home's pane, each leading there: where they left off (the file last
 * read in Forge, to go on writing in), the conversations with something not read, the boards with posts not seen.
 * With nothing new it says so, quietly: the pane out is never a line with nothing beside it.
 */
function lately(ctx: Context): HTMLElement {
  const list = h('div', {class: 'lately-list'});
  const box = h('section', {class: 'lately', 'aria-labelledby': 'lately-title'}, h('h2', {id: 'lately-title'}, t('Lately')), list);
  const row = (what: string, line: string, go: () => void, fresh = false, quote = '') => {
    const b = h('button', {type: 'button', class: 'lately-row'},
      h('span', {class: 'lately-what'}, h('span', {}, what), fresh ? h('span', {class: 'lately-dot', 'aria-hidden': 'true'}) : null),
      quote ? h('span', {class: 'lately-quote'}, quote) : null,
      h('span', {class: 'muted small lately-line'}, line));
    b.addEventListener('click', go);
    return b;
  };
  let asked = 0;
  const paint = async () => {
    const mine = ++asked;
    const rows: HTMLElement[] = [];
    const left = ctx.leftOff;
    if (left && (await store.list().catch(() => [])).some((r) => r.name === left.repo)) {
      // The line it was left at, as it is now: what was being written, to be taken up again.
      const text = left.at === null ? null : (await store.read(left.repo, left.path).catch(() => null))?.text ?? null;
      const end = text === null || left.at === null ? -1 : text.indexOf('\n', left.at);
      const quote = text === null ? '' : text.slice(0, end < 0 ? text.length : end).split('\n').reverse().find((l) => l.trim())?.trim() ?? '';
      rows.push(row(left.path.slice(left.path.lastIndexOf('/') + 1), t('{repo} · where you left off', {repo: left.repo}),
        () => ctx.openRepo(left.repo, left.path, left.at === null ? 'end' : {at: left.at}), false, quote));
    }
    if (connection()) {
      const [threads, all] = await Promise.all([inbox.threads().catch(() => []), servers.servers().catch(() => [])]);
      for (const th of threads.filter((x) => x.unread > 0).slice(0, 3)) {
        rows.push(row(th.name || inbox.shown(th.address), th.last.body, () => { openConversation(th.address); void ctx.go('inbox'); }, true));
      }
      for (const b of news().boards.slice(0, 3)) {
        const s = all.find((x) => x.id === b.server);
        const board = s?.boards.find((x) => x.id === b.id);
        if (!s || !board) continue;
        rows.push(row(`#${board.name}`, t('{server} · new posts', {server: s.name}), () => {
          try { localStorage.setItem('length3.server.at', JSON.stringify({server: s.id, board: board.id})); } catch { /* a convenience */ }
          void ctx.go('server');
        }, true));
      }
    }
    if (mine !== asked) return;
    list.replaceChildren(...(rows.length ? rows : [h('p', {class: 'muted small lately-none'}, t('Nothing new'))]));
  };
  void paint();
  const off = onNews(() => { if (!box.isConnected) { off(); return; } void paint(); });
  return box;
}

/** The servers the person is in (Server holds them), and how many in the counts. */
function ownServers(ctx: Context): HTMLElement {
  const box = h('div', {class: 'home-servers'}, h('p', {class: 'muted'}, t('In no server yet')));
  if (!connection()) return box;
  void servers.servers().then((list) => {
    const n = document.getElementById('server-count');
    if (n) counting(n, list.length, 'server', 'servers');
    if (!list.length) return;
    box.replaceChildren(...list.map((s) => {
      const b = h('button', {type: 'button', class: 'chip'}, s.name);
      b.addEventListener('click', () => { try { localStorage.setItem('length3.server.at', JSON.stringify({server: s.id})); } catch { /* a convenience */ } ctx.go('server'); });
      return b;
    }));
  }, (e) => box.replaceChildren(h('p', {class: 'error'}, errorText(e))));
  return box;
}

const servers0 = () => { const el = h('span', {id: 'server-count'}); counting(el, 0, 'server', 'servers'); return el; };

/** A count and its word: one repo, 2 repos (Japanese tells them apart by the number alone). */
function counting(el: HTMLElement, n: number, one: string, many: string) {
  el.replaceChildren(h('b', {}, String(n)), ' ', tn(one, many, n));
}

function identity(counts: HTMLElement): HTMLElement {
  const profile = currentProfile();
  const named = profile.name || profile.handle;
  return h('div', {class: 'identity'},
    named ? h('h1', {}, profile.name || `@${profile.handle}`) : h('h1', {class: 'unset'}, t('No name yet')),
    profile.handle && profile.name ? h('p', {class: 'handle'}, `@${profile.handle}`) : null,
    profile.bio ? h('p', {class: 'bio'}, profile.bio) : null,
    counts,
  );
}

/**
 * The profile at Home's top: the face, the name, the counts, and Edit profile. It is edited where it is read: the
 * name becomes the line it is written on, where it stands and as large; the handle and the line about the person
 * come in under it; Edit profile gives way to Cancel and Save. The top grows and shrinks to what it holds rather
 * than jumping, the face gives a little wiggle as the form opens, and saved, it turns round to show its new
 * initials (or nods, when they are the same) while the name settles where it is shown.
 */
function profileHeader(count: HTMLElement, owner: boolean): HTMLElement {
  const avatar = h('div', {class: 'avatar', 'aria-hidden': 'true'});
  const header = h('section', {class: 'profile'});
  const face = () => [initials(currentProfile()) || mark('person')];
  /** Drawn as it is now; from another state (`beat`), its height goes from what it was, and the face says so. */
  const draw = (beat: 'open' | 'saved' | 'cancel' | null, faceWas: Node[] = []) => {
    const from = header.getBoundingClientRect().height;
    avatar.replaceChildren(...face());
    const counts = h('p', {class: 'counts'}, count, servers0());
    // Written in, the face follows what is written: the initials the name (or the handle) gives, at once.
    const form = editing ? editForm(done, (p) => avatar.replaceChildren(initials(p) || mark('person'))) : null;
    const edit = owner && !editing ? h('button', {class: 'button', type: 'button'}, t('Edit profile')) as HTMLButtonElement : null;
    edit?.addEventListener('click', () => { editing = true; draw('open'); header.querySelector<HTMLInputElement>('#profile-name')?.focus(); });
    header.replaceChildren(avatar, form?.element ?? identity(counts), ...(form ? [form.acts] : edit ? [edit] : []));
    header.classList.toggle('editing', editing);
    if (!beat || still() || !header.isConnected) return;
    const to = header.getBoundingClientRect().height;
    if (Math.abs(to - from) > 1) {
      header.style.overflow = 'clip';
      header.animate([{height: `${from}px`}, {height: `${to}px`}], {duration: paced(320), easing: LAND}).finished.then(() => { header.style.overflow = ''; }, () => { header.style.overflow = ''; });
    }
    if (beat === 'open') {
      avatar.animate([{rotate: '0deg'}, {rotate: '-10deg'}, {rotate: '7deg'}, {rotate: '-3deg'}, {rotate: '0deg'}], {duration: paced(480), easing: 'ease-in-out'});
      // What was not there comes in under the name, a line after another.
      [...header.querySelectorAll<HTMLElement>('.handle-field, .bio-field, .edit-acts')].forEach((el, i) =>
        el.animate([{opacity: 0, translate: '0 -6px'}, {opacity: 1, translate: '0 0'}], {duration: paced(240), delay: paced(60 + i * 50), easing: LAND, fill: 'backwards'}));
    } else if (beat === 'saved') {
      const name = header.querySelector<HTMLElement>('.identity h1');
      if (name) pop(name, .04, 320);
      const now = [...avatar.childNodes];
      const same = faceWas.map((n) => n.textContent).join() === now.map((n) => n.textContent).join();
      if (same) { pop(avatar, .06, 300); return; }
      // It turns away showing the face it had, and comes round showing the new one.
      avatar.replaceChildren(...faceWas);
      avatar.animate([{transform: 'perspective(400px) rotateY(0deg)'}, {transform: 'perspective(400px) rotateY(90deg)'}], {duration: paced(150), easing: 'ease-in'}).finished.then(() => {
        avatar.replaceChildren(...now);
        avatar.animate([{transform: 'perspective(400px) rotateY(-90deg)'}, {transform: 'perspective(400px) rotateY(0deg)'}], {duration: paced(300), easing: 'cubic-bezier(.2, 1.4, .32, 1)'});
      }, () => avatar.replaceChildren(...now));
    }
  };
  const done = (saved: boolean) => {
    const faceWas = [...avatar.childNodes].map((n) => n.cloneNode(true));
    editing = false;
    draw(saved ? 'saved' : 'cancel', faceWas);
    header.querySelector<HTMLElement>(':scope > .button')?.focus({preventScroll: true});
  };
  draw(null);
  // Opened from the person's menu: it opens as Edit profile opens it, once Home is on the screen.
  if (opening) { opening = false; requestAnimationFrame(() => { if (!header.isConnected || still()) return; avatar.animate([{rotate: '0deg'}, {rotate: '-10deg'}, {rotate: '7deg'}, {rotate: '-3deg'}, {rotate: '0deg'}], {duration: paced(480), easing: 'ease-in-out'}); }); }
  return header;
}

/**
 * The profile as it is written, on a sheet of its own: the name on its own line as large as it reads, @ and the
 * handle under it, the line about the person under that, each a line written on with room between them (an ink
 * line under the one with the keyboard); the counts, which are not written, step aside. Cancel and Save stand where
 * Edit profile stood. Enter on the name or the handle saves, Escape leaves it as it was. `faced` is told each change.
 */
function editForm(done: (saved: boolean) => void, faced: (p: {name: string; handle: string; bio: string}) => void): {element: HTMLElement; acts: HTMLElement} {
  const profile = currentProfile();
  const name = h('input', {id: 'profile-name', class: 'name-in', maxlength: String(LIMITS.name), autocomplete: 'name',
    placeholder: t('Your name'), 'aria-label': t('Name')}) as HTMLInputElement;
  const handle = h('input', {id: 'profile-handle', class: 'handle-in', maxlength: String(LIMITS.handle), autocapitalize: 'off', spellcheck: 'false',
    placeholder: t('handle'), 'aria-label': t('Handle')}) as HTMLInputElement;
  const bio = h('textarea', {id: 'profile-bio', class: 'bio-in', maxlength: String(LIMITS.bio), rows: '1',
    placeholder: t('A line about you'), 'aria-label': t('Bio')}) as HTMLTextAreaElement;
  name.value = profile.name; handle.value = profile.handle; bio.value = profile.bio;
  // The line about the person is as tall as what is written in it.
  const fit = () => { bio.style.height = 'auto'; bio.style.height = `${bio.scrollHeight}px`; };
  bio.addEventListener('input', fit);
  requestAnimationFrame(fit);
  const error = h('p', {class: 'error', role: 'alert'});
  const form = h('form', {id: 'profile-form', class: 'edit identity'},
    name, h('span', {class: 'handle-field'}, '@', handle), h('span', {class: 'bio-field'}, bio), error) as HTMLFormElement;
  for (const f of [name, handle]) f.addEventListener('input', () => faced({name: name.value, handle: handle.value.replace(/^@/, ''), bio: ''}));
  const cancel = h('button', {class: 'button', type: 'button', 'data-cancel': ''}, t('Cancel'));
  const save = h('button', {class: 'button primary', type: 'submit', form: 'profile-form'}, t('Save'));
  const acts = h('div', {class: 'edit-acts'}, cancel, save);
  for (const f of [name, handle]) f.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); done(false); } });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = normalize({name: name.value, handle: handle.value, bio: bio.value});
    if (result.error) { error.textContent = t('A handle is up to 32 lowercase letters, digits, - and _'); handle.focus(); nudge(handle); return; }
    try { await setState('profile', JSON.stringify(result.profile)); } catch (e) {
      error.textContent = t('Could not save: {message}', {message: errorText(e)});
      return;
    }
    // Signed in, the name is the account's too: what is started, committed and reviewed from here says it.
    if (result.profile.name) {
      try { await rename(result.profile.name); } catch (e) {
        error.textContent = t('Saved here; the Remote still has the name it had ({message})', {message: errorText(e)});
        return;
      }
    }
    done(true);
  });
  cancel.addEventListener('click', () => done(false));
  return {element: form, acts};
}

