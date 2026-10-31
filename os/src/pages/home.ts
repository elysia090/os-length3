import {agentCards} from './agent-cards.ts';
import {arrowKeys, h} from '../ui/dom.ts';
import {t, tn} from '../i18n.ts';
import {LIMITS, initials, normalize, parse, type Profile} from '../home/profile.ts';
import {connection, myName, rename} from '../remote/connection.ts';
import {getState, setState, settingName, unreadable} from '../home/state.ts';
import * as servers from '../remote/servers.ts';
import * as inbox from '../remote/inbox.ts';
import {news, onNews} from '../remote/news.ts';
import {onRenamed, store, type RepoSummary} from '../repos/repos.ts';
import {shownName} from '../repos/issues.ts';
import {repoList} from './repo-list.ts';
import {todoBox} from './todo-list.ts';
import {remember} from './server/parts.ts';
import {Reference} from './forge/reference.ts';
import type {Context} from './context.ts';
import {latelyRow, onRightPane, pluginArea, rightPaneOpen, setRightPane, waiting, wordLine} from './pane.ts';
import {mark, paneMark} from '../ui/icons.ts';
import {onPlugins, pluginsOpen} from '../app/plugins.ts';
import {errorText} from '../app/errors.ts';
import {LAND, after, nudge, paced, paneIn, paneOut, still} from '../ui/glide.ts';

let editing = false;

/** The profile as it stands (Home's state, see state.ts), for Home and the rail's own icon. */
export const currentProfile = (): Profile => parse(getState('profile'));

/** Open Home with the profile form out. */
export function startEditing(ctx: Context) {
  editing = true;
  void ctx.go('home').then(() => document.getElementById('profile-name')?.focus());
}

/** Home: a profile that reads the same for its owner and for anyone else. */
export function home(ctx: Context): Node[] {
  const owner = true;
  const count = h('span', {});
  const list = repoList(ctx, {newCard: true, counted: (n) => counting(count, n, 'repo', 'repos')});
  const listed = list.refresh();
  const grid = list.element;
  // About three across at a laptop's width (styles.css): Home's own, so New repo's list and other grids stay as they are.
  grid.classList.add('home-repos');
  const header = profileHeader(count, owner);
  // A setting that could not be read is said here, where the person looks first; it is not written over meanwhile.
  const unread = [...unreadable()].map(([k, why]) => h('p', {class: 'error', role: 'alert'}, t('Could not read {what} ({why})', {what: settingName(k), why})));
  const main = h('div', {class: 'home-main'}, header, ...unread, todoBox(),
    h('section', {class: 'section', 'aria-labelledby': 'repos-title'}, h('h2', {id: 'repos-title'}, t('Repos')), grid),
    h('section', {class: 'section', 'aria-labelledby': 'servers-title'},
      h('h2', {id: 'servers-title'}, t('Servers')), ownServers(ctx)));
  return [homePane(main, ctx, listed)];
}

/**
 * Home with the right pane Forge and Git have, in the same place and put away and brought back by the same switch
 * at its top (one setting for all three): at its top the plugin area (plain until the rail's plug opens it, here
 * as there). It stays where it is while Home scrolls under the rail; put away, Home takes the width.
 */
function homePane(main: HTMLElement, ctx: Context, listed: Promise<RepoSummary[] | null>): HTMLElement {
  const side = h('aside', {class: 'home-side', id: 'home-side', 'aria-label': t('Recent activity')}, pluginArea(), agentCards((repo, issue) => { void import('./git/git.ts').then((g) => { g.showIssue(repo, issue.replace(/^issue\//, '')); void ctx.go('git'); }); }), lately(ctx));
  const toggle = h('button', {type: 'button', class: 'pane-toggle', 'aria-label': t('Right pane'), 'aria-controls': 'home-side'}, paneMark()) as HTMLButtonElement;
  // The search Forge and Git have, where theirs is: in the repo last worked in (named in it, there being no band to
  // say which), what is found opened in Forge, at its line.
  let repo = ctx.repo;
  const reference = new Reference({reveal: (path, line, write) => { if (repo) ctx.openRepo(repo, path, write ?? false, undefined, line ?? 0); }});
  const aim = (name: string | null) => { repo = name; reference.setRepo(name); reference.named(name); };
  aim(repo);
  const pane = h('div', {class: 'home-pane'}, h('div', {class: 'home-bar'}, reference.search, toggle), side);
  // None worked in yet (or it is gone): the one changed last (the first of the cards' list, read once for both), so the
  // box is never there to be pressed for nothing.
  void listed.then((all) => { if (all && pane.isConnected && !(repo && all.some((r) => r.name === repo))) aim(all[0]?.name ?? null); });
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
  // While it is put away or brought out, its side and search stay as wide as they are out (styles.css .pane-moving):
  // the side goes with its edge and is cut at the window's, as Forge's does, and the search goes where it stands;
  // neither is squeezed as the pane narrows or widens.
  let moving: Animation | null = null;
  const held = () => {
    // Both read before either is written (a write between would have the page laid out again for the second read),
    // and written only when changed: the side resized as the first page fills in is heard many times.
    const w = side.offsetWidth, s = reference.search.offsetWidth;
    if (!rightPaneOpen() || layout.classList.contains('pane-moving') || !w) return;
    const sw = `${w}px`, ss = `${s}px`;
    if (pane.style.getPropertyValue('--side-held') !== sw) pane.style.setProperty('--side-held', sw);
    if (pane.style.getPropertyValue('--search-held') !== ss) pane.style.setProperty('--search-held', ss);
  };
  new ResizeObserver(held).observe(side);
  const paint = () => {
    const open = rightPaneOpen();
    // Brought back before it had gone: what it holds is still there, and stays.
    const there = layout.isConnected && getComputedStyle(side).visibility === 'visible';
    if (open !== was && layout.isConnected && !still()) {
      // Never out yet at this width: as wide as they will be out, measured before it sets off.
      if (open && !pane.style.getPropertyValue('--side-held')) {
        layout.style.transition = 'none';
        layout.classList.remove('pane-closed');
        held();
        layout.classList.add('pane-closed');
        void layout.offsetWidth;
        layout.style.transition = '';
      }
      layout.classList.add('pane-moving');
      moving?.cancel();
      moving = after(460, () => { layout.classList.remove('pane-moving'); held(); });
    }
    layout.classList.toggle('pane-closed', !open);
    toggle.setAttribute('aria-expanded', String(open));
    if (open && !was && layout.isConnected) paneOut(side, toggle, reference.search, !there);
    if (!open && was) paneIn(side);
    was = open;
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
 * read in Forge, to go on writing in), the conversations with something not read, the boards with posts not seen,
 * and the boards they write in as a guest.
 * With nothing new it says so, quietly: the pane out is never a line with nothing beside it.
 */
function lately(ctx: Context): HTMLElement {
  const list = h('div', {class: 'lately-list'});
  arrowKeys(list, '.lately-row');
  const box = h('section', {class: 'lately', 'aria-labelledby': 'lately-title'}, h('h2', {id: 'lately-title'}, t('Recent activity')), list);
  let asked = 0;
  const paint = async () => {
    const mine = ++asked;
    const rows: HTMLElement[] = [];
    const left = ctx.leftOff;
    if (left && (await store.names().catch((): string[] => [])).includes(left.repo)) {
      // The line it was left at, as it is now: what was being written, to be taken up again; or the nearest above it
      // with a word in it (a closing brace alone says nothing of where one was).
      const text = left.at === null ? null : (await store.read(left.repo, left.path).catch(() => null))?.text ?? null;
      const end = text === null || left.at === null ? -1 : text.indexOf('\n', left.at);
      const quote = text === null ? '' : text.slice(0, end < 0 ? text.length : end).split('\n').reverse().find((l) => /[\p{L}\p{N}]/u.test(l))?.trim() ?? '';
      const goOn = () => ctx.openRepo(left.repo, left.path, left.at === null ? 'end' : {at: left.at});
      rows.push(latelyRow(shownName(left.path), t('{repo} · Continue where you left off', {repo: left.repo}), {quote, place: left.repo, badge: 'file', go: goOn}));
    }
    // The servers and the conversations asked at once: neither waits on the other (one round to the Remote, not two).
    const [all, threads] = connection()
      ? await Promise.all([servers.servers().catch(() => []), inbox.threads().catch(() => [])])
      : [[], []];
    if (connection()) {
      for (const th of waiting(threads, 3)) {
        const who = th.name || inbox.shown(th.address);
        const answer = () => { void import('./inbox.ts').then((i) => { i.openNext(th.address); void ctx.go('inbox'); }); };
        rows.push(latelyRow(who, wordLine(th), {fresh: true, badge: {who}, go: answer}));
      }
      for (const b of news().boards.slice(0, 3)) {
        const s = all.find((x) => x.id === b.server);
        const board = s?.boards.find((x) => x.id === b.id);
        if (!s || !board) continue;
        const there = () => {
          remember({server: s.id, board: board.id});
          void ctx.go('server');
        };
        rows.push(latelyRow(board.name, t('{server} · New posts', {server: s.name}), {fresh: true, badge: 'board', go: there}));
      }
    }
    // The boards this browser writes in as a guest (none of its servers'): where one writes, a way back always,
    // signed in or not; its look reads the board and writes in it as the guest.
    const ours = new Set(all.flatMap((s) => s.boards.map((x) => x.id)));
    for (const {id, here} of servers.guestBoards().filter((g) => !ours.has(g.id)).slice(0, 3)) {
      const there = () => { remember({board: id}); void ctx.go('server'); };
      rows.push(latelyRow(here.name, t('{server} · Joined as guest', {server: here.server}), {badge: 'board', go: there}));
    }
    if (mine !== asked) return;
    list.replaceChildren(...(rows.length ? rows : [h('p', {class: 'muted small lately-none'}, t('Nothing new'))]));
  };
  void paint();
  list.addEventListener('look-closed', () => void paint());
  const off = onNews(() => { if (!box.isConnected) { off(); return; } void paint(); });
  // A repo renamed: where one left off says it under its new name.
  const offRenamed = onRenamed(() => { if (!box.isConnected) { offRenamed(); return; } void paint(); });
  return box;
}

/**
 * The servers the person is in (Server holds them), and how many in the counts; after them, the boards this browser
 * writes in as a guest, each a way back to it (a guest come back, signed in or not, has nothing else leading there).
 */
function ownServers(ctx: Context): HTMLElement {
  const box = h('div', {class: 'home-servers'});
  const guesting = servers.guestBoards().map(({id, here}) => {
    const said = t('#{board} ({server}) · Guest', {board: here.name, server: here.server});
    const b = h('button', {type: 'button', class: 'chip guest-chip', title: said, 'aria-label': said},
      `#${here.name}`, h('span', {class: 'muted small'}, `${here.server} · ${t('Guest')}`));
    b.addEventListener('click', () => { remember({board: id}); ctx.go('server'); });
    return {id, b};
  });
  const fill = (list: servers.Server[]) => {
    const ours = new Set(list.flatMap((s) => s.boards.map((x) => x.id)));
    const each = list.map((s) => {
      const b = h('button', {type: 'button', class: 'chip'}, s.name);
      b.addEventListener('click', () => { remember({server: s.id}); ctx.go('server'); });
      return b;
    });
    // A board of a server one is in is that server's chip's, not a guest's.
    const guests = guesting.filter((g) => !ours.has(g.id)).map((g) => g.b);
    box.replaceChildren(...(each.length || guests.length ? [...each, ...guests] : [h('p', {class: 'muted'}, t('Not a member of any server'))]));
  };
  fill([]);
  if (!connection()) return box;
  void servers.servers().then((list) => {
    const n = document.getElementById('server-count');
    if (n) counting(n, list.length, 'server', 'servers');
    fill(list);
  }, (e) => box.replaceChildren(h('p', {class: 'error'}, errorText(e))));
  return box;
}

/** A count that goes to its section (`title` its heading's id): scrolled to, its heading lit as it lands. */
function toSection(count: HTMLElement, title: string): HTMLElement {
  const b = h('button', {type: 'button', class: 'count-go'}, count);
  b.addEventListener('click', () => {
    const head = document.getElementById(title);
    if (!head) return;
    head.closest('section')?.scrollIntoView({behavior: still() ? 'auto' : 'smooth', block: 'start'});
    head.classList.remove('landed'); void head.offsetWidth; head.classList.add('landed');
  });
  return b;
}

const servers0 = () => { const el = h('span', {id: 'server-count'}); counting(el, 0, 'server', 'servers'); return el; };

/** A count and its word: one repo, 2 repos (Japanese tells them apart by the number alone). */
function counting(el: HTMLElement, n: number, one: string, many: string) {
  el.replaceChildren(h('b', {}, String(n)), ' ', tn(one, many, n));
}

function identity(counts: HTMLElement): HTMLElement {
  const profile = currentProfile();
  const name = h('h1', {}), handle = h('p', {class: 'handle'});
  /** The name to be called by over the handle; the handle alone where there is no name. */
  const paint = (called: string, user: string) => {
    name.textContent = called || (user ? `@${user}` : t('No name set'));
    name.classList.toggle('unset', !called && !user);
    handle.textContent = called && user ? `@${user}` : '';
    handle.hidden = !handle.textContent;
  };
  paint(profile.name, profile.handle);
  // Signed in, one person, one name: none written here yet, it is the one signed in with (the Remote's); and the
  // handle is their username there, the one name others find them by, kept on the profile too as it changes.
  void Promise.all([profile.name || myName().catch(() => ''), inbox.myUsername().catch(() => '')]).then(([called, user]) => {
    if (!called && !user) return;
    paint(called, user || profile.handle);
    if (user && user !== profile.handle) void setState('profile', JSON.stringify({...profile, handle: user})).catch(() => {});
  });
  return h('div', {class: 'identity'},
    name,
    handle,
    profile.bio ? h('p', {class: 'bio'}, profile.bio) : null,
    counts,
  );
}

/**
 * The profile at Home's top: the face, the name, the counts, and Edit profile. It is edited where it is read: the
 * name becomes the line it is written on, where it stands and as large; the handle and the line about the person
 * come in under it; Edit profile gives way to Cancel and Save. The top grows and shrinks to what it holds rather
 * than jumping, one move at a time: what is under it goes with it, never up and then down; saved with new initials,
 * once it has folded, the face turns round to show them.
 */
function profileHeader(count: HTMLElement, owner: boolean): HTMLElement {
  const avatar = h('div', {class: 'avatar', 'aria-hidden': 'true'});
  const header = h('section', {class: 'profile'});
  const face = () => [initials(currentProfile()) || mark('person')];
  /** Drawn as it is now; from another state (`beat`), its height goes from what it was, and the face says so. */
  /** The room it takes in the page: its box and the margins round it (written in, the sheet grows out past its place). */
  const room = () => {
    const cs = getComputedStyle(header);
    return {height: header.getBoundingClientRect().height, margins: parseFloat(cs.marginTop) + parseFloat(cs.marginBottom)};
  };
  const draw = (beat: 'open' | 'saved' | 'cancel' | null, faceWas: Node[] = []) => {
    const was = room(), from = was.height + was.margins;
    avatar.replaceChildren(...face());
    // Each count is the way to what it counts, further down Home (as a profile's counts are): pressed, there it is.
    const counts = h('p', {class: 'counts'}, toSection(count, 'repos-title'), toSection(servers0(), 'servers-title'));
    // Written in, the face follows what is written: the initials the name (or the handle) gives, at once.
    const form = editing ? editForm(done, (p) => avatar.replaceChildren(initials(p) || mark('person'))) : null;
    const edit = owner && !editing ? h('button', {class: 'button', type: 'button'}, t('Edit profile')) as HTMLButtonElement : null;
    const open = () => { editing = true; draw('open'); header.querySelector<HTMLInputElement>('#profile-name')?.focus(); };
    edit?.addEventListener('click', open);
    // The face is what one changes first: pressed, the profile opens to be written, as Edit profile does.
    avatar.classList.toggle('pressable', !!edit);
    avatar.onclick = edit ? open : null;
    header.replaceChildren(avatar, form?.element ?? identity(counts), ...(form ? [form.acts] : edit ? [edit] : []));
    header.classList.toggle('editing', editing);
    if (!beat || still() || !header.isConnected) return;
    // The room it takes goes from what it was to what it is in one move: the sheet's margins (it grows out past its
    // place as it opens) come and go at once, so its height starts where that leaves the page as it was, and nothing
    // under it moves but with it (it went up and then down, with the margins and the height each on their own).
    const now = room(), to = now.height, start = from - now.margins;
    let settled: Promise<unknown> = Promise.resolve();
    if (Math.abs(to - start) > 1) {
      header.style.overflow = 'clip';
      const grow = header.animate([{height: `${start}px`}, {height: `${to}px`}], {duration: paced(320), easing: LAND});
      settled = grow.finished.catch(() => {});
      void settled.then(() => { header.style.overflow = ''; });
    }
    // One move at a time: the sheet grows or folds, and only what that move is about comes with it.
    if (beat === 'open') {
      // What was not there comes in under the name, a line after another, into the room the sheet makes.
      [...header.querySelectorAll<HTMLElement>('.handle-field, .bio-field, .edit-acts')].forEach((el, i) =>
        el.animate([{opacity: 0, translate: '0 -6px'}, {opacity: 1, translate: '0 0'}], {duration: paced(240), delay: paced(60 + i * 50), easing: LAND, fill: 'backwards'}));
    } else if (beat === 'saved') {
      const now = [...avatar.childNodes];
      const same = faceWas.map((n) => n.textContent).join() === now.map((n) => n.textContent).join();
      if (same) return;
      // New initials, once the sheet has folded: it turns away showing the face it had, and comes round showing them.
      avatar.replaceChildren(...faceWas);
      void settled.then(() => {
        if (!avatar.isConnected) return;
        avatar.animate([{transform: 'perspective(400px) rotateY(0deg)'}, {transform: 'perspective(400px) rotateY(90deg)'}], {duration: paced(150), easing: 'ease-in'}).finished.then(() => {
          avatar.replaceChildren(...now);
          avatar.animate([{transform: 'perspective(400px) rotateY(-90deg)'}, {transform: 'perspective(400px) rotateY(0deg)'}], {duration: paced(300), easing: 'cubic-bezier(.2, 1.4, .32, 1)'});
        }, () => avatar.replaceChildren(...now));
      });
    }
  };
  const done = (saved: boolean) => {
    const faceWas = [...avatar.childNodes].map((n) => n.cloneNode(true));
    editing = false;
    draw(saved ? 'saved' : 'cancel', faceWas);
    header.querySelector<HTMLElement>(':scope > .button')?.focus({preventScroll: true});
  };
  // Opened from the person's menu, it is drawn open: Home's arrival is the beat, and a wiggle of the face on top of
  // the page panning in would be two moves at once.
  draw(null);
  return header;
}

/**
 * The profile as it is written, on a sheet of its own: the name on its own line as large as it reads, @ and the
 * handle under it, the line about the person under that, each a line written on with room between them (an ink
 * line under the one with the keyboard); the counts, which are not written, step aside. Cancel and Save stand where
 * Edit profile stood. Enter on the name or the handle saves, Escape leaves it as it was. `faced` is told each change.
 * The handle is offered signed in only: it is their username, how others find them, and changed here it is changed
 * on the Remote first (taken, it says so at the handle, and nothing is saved).
 */
function editForm(done: (saved: boolean) => void, faced: (p: {name: string; handle: string; bio: string}) => void): {element: HTMLElement; acts: HTMLElement} {
  const profile = currentProfile();
  const name = h('input', {id: 'profile-name', class: 'name-in', maxlength: String(LIMITS.name), autocomplete: 'name',
    placeholder: t('Your name'), 'aria-label': t('Name')}) as HTMLInputElement;
  const handle = h('input', {id: 'profile-handle', class: 'handle-in', maxlength: String(LIMITS.handle), autocapitalize: 'off', spellcheck: 'false',
    placeholder: t('handle'), 'aria-label': t('Handle')}) as HTMLInputElement;
  const bio = h('textarea', {id: 'profile-bio', class: 'bio-in', maxlength: String(LIMITS.bio), rows: '1',
    placeholder: t('Short bio'), 'aria-label': t('Bio')}) as HTMLTextAreaElement;
  name.value = profile.name; handle.value = profile.handle; bio.value = profile.bio;
  const signedIn = !!connection();
  const was = signedIn ? inbox.myUsername().catch(() => profile.handle) : Promise.resolve(profile.handle);
  void was.then((u) => { if (u && handle.value === profile.handle && handle.isConnected) handle.value = u; });
  // None written yet, the name shown is the one signed in with (identity): it is what is there to change, not an
  // empty line beside it. Nothing typed is written over, and the face takes it up as it would what is typed.
  if (!profile.name) {
    void myName().then((n) => {
      if (!n || name.value || !name.isConnected) return;
      name.value = n;
      faced({name: n, handle: handle.value.replace(/^@/, ''), bio: ''});
    }, () => {});
  }
  // The line about the person is as tall as what is written in it.
  const fit = () => { bio.style.height = 'auto'; bio.style.height = `${bio.scrollHeight}px`; };
  bio.addEventListener('input', fit);
  requestAnimationFrame(fit);
  const error = h('p', {class: 'error', role: 'alert'});
  const form = h('form', {id: 'profile-form', class: 'edit identity'},
    name, signedIn ? h('span', {class: 'handle-field'}, '@', handle) : null, h('span', {class: 'bio-field'}, bio), error) as HTMLFormElement;
  for (const f of [name, handle]) f.addEventListener('input', () => faced({name: name.value, handle: handle.value.replace(/^@/, ''), bio: ''}));
  const cancel = h('button', {class: 'button', type: 'button', 'data-cancel': ''}, t('Cancel'));
  const save = h('button', {class: 'button primary', type: 'submit', form: 'profile-form'}, t('Save'));
  const acts = h('div', {class: 'edit-acts'}, cancel, save);
  for (const f of [name, handle]) f.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.isComposing) { e.preventDefault(); done(false); } });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const result = normalize({name: name.value, handle: handle.value, bio: bio.value});
    const atHandle = (said: string) => { error.textContent = said; handle.focus(); nudge(handle); };
    if (result.error) { atHandle(t('Handle must be 2–31 lowercase letters, digits, or . - _')); return; }
    // Their username changed on the Remote first: taken, or changed too often, it is said at the handle. Left empty,
    // it is as it was (a username is changed, never taken away).
    if (signedIn && !result.profile.handle) result.profile.handle = await was;
    if (signedIn && result.profile.handle && result.profile.handle !== await was) {
      try { result.profile.handle = await inbox.changeUsername(result.profile.handle); } catch (e) { atHandle(errorText(e)); return; }
    }
    try { await setState('profile', JSON.stringify(result.profile)); } catch (e) {
      error.textContent = t('Failed to save: {message}', {message: errorText(e)});
      return;
    }
    // Signed in, the name is the account's too: what is started, committed and reviewed from here says it.
    if (result.profile.name) {
      try { await rename(result.profile.name); } catch (e) {
        error.textContent = t('Saved locally; Remote name unchanged ({message})', {message: errorText(e)});
        return;
      }
    }
    done(true);
  });
  cancel.addEventListener('click', () => done(false));
  return {element: form, acts};
}

