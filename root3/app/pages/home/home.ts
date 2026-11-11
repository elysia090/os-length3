import {openNext} from '../kit/next.ts';
import {agentCards} from '../kit/agent-cards.ts';
import {arrowKeys, h} from '../../ui/dom.ts';
import {t, tn} from '../../i18n/i18n.ts';
import {LIMITS, normalize, parse, type Profile} from '../../home/profile.ts';
import {connection, myName, rename} from '../../remote/connection.ts';
import {getState, onState, setState, settingName, unreadable} from '../../home/state.ts';
import * as servers from '../../remote/servers.ts';
import * as inbox from '../../remote/inbox.ts';
import {news, onNews} from '../../remote/news.ts';
import {onRenamed, store, type RepoSummary} from '../../repos/repos.ts';
import {homeIsHeld} from '../../remote/lifecycle.ts';
import {shownName} from '../../repos/issues.ts';
import {repoList} from './repo-list.ts';
import {todoBox} from '../kit/todo-list.ts';
import {remember} from '../server/parts.ts';
import {Reference} from '../bench/reference.ts';
import type {Context} from '../kit/context.ts';
import {latelyRow, onRightPane, pluginArea, rightPaneOpen, setRightPane, waiting, wordLine} from '../kit/pane.ts';
import {mark, paneMark, type MarkName} from '../../ui/icons.ts';
import {fitSize} from '../../ui/optical.ts';
import {onPlugins, pluginsOpen} from '../../host/plugins.ts';
import {errorText} from '../../host/errors.ts';
import {after, nudge, paneIn, paneOut, still} from '../../ui/glide.ts';

/** The profile as it stands (Home's state, see state.ts), for Home and the rail's own icon. */
export const currentProfile = (): Profile => parse(getState('profile'));

/** Open Home with the caret in the name, to write it. */
export function startEditing(ctx: Context) {
  void ctx.go('home').then(() => document.getElementById('profile-name')?.focus());
}

/**
 * Home: the person's name as large as Home is wide, and under it what is theirs to do beside where it is done: the
 * TODO, a box as Forge's are, and the repos and servers as a column of their names, each pressed to go there.
 */
export function home(ctx: Context): Node[] {
  const owner = true;
  const count = h('span', {});
  const list = repoList(ctx, {newCard: true, brief: true, counted: (n) => counting(count, n, 'repo', 'repos')});
  const listed = list.refresh();
  const grid = list.element;
  // A column of names (home.css), Home's own: New repo's list and other grids stay cards.
  grid.classList.add('home-repos');
  const header = profileHeader(count, owner);
  // A setting that could not be read is said here, where the person looks first; it is not written over meanwhile.
  const unread = [...unreadable()].map(([k, why]) => h('p', {class: 'error', role: 'alert'}, t('Could not read {what} ({why})', {what: settingName(k), why})));
  const places = h('div', {class: 'home-places'},
    h('section', {class: 'section', 'aria-labelledby': 'repos-title'}, h('h2', {id: 'repos-title'}, t('Repos')), grid),
    h('section', {class: 'section', 'aria-labelledby': 'servers-title'}, h('h2', {id: 'servers-title'}, t('Servers')), ownServers(ctx)));
  // Two columns from the page's top: the person's own (the name, then what is theirs to do) and, beside it from the
  // name's height, where their work is (home.css .home-desk).
  const main = h('div', {class: 'home-main'}, h('div', {class: 'home-desk'}, h('div', {class: 'home-own'}, header, ...unread, todoBox()), places));
  return [onTheGround(main, ctx, listed)];
}

/**
 * Home (and New repo) laid as Forge is: a band along its top, held there while Home scrolls under it, with the search Forge has; the
 * right pane Forge and Git have, in the same place, its switch at its foot where Forge's is (one setting for all
 * three); at the pane's top the plugin area (plain until the rail's plug opens it, here as there). Put away, Home
 * takes the width.
 */
export function onTheGround(main: HTMLElement, ctx: Context, listed: Promise<RepoSummary[] | null>): HTMLElement {
  const side = h('aside', {class: 'home-side', id: 'home-side', 'aria-label': t('Recent activity')}, pluginArea(), agentCards((repo, issue) => { void import('../git/git.ts').then((g) => { g.showIssue(repo, issue.replace(/^issue\//, '')); void ctx.go('git'); }); }), lately(ctx));
  const toggle = h('button', {type: 'button', class: 'pane-toggle', 'aria-label': t('Right pane'), 'aria-controls': 'home-side'}, paneMark()) as HTMLButtonElement;
  // The search Forge has, on the band as Forge's is: in the repo last worked in (named in it, there being no repos on
  // the band to say which), what is found dropped as a sheet over Home and opened in Forge, at its line.
  let repo = ctx.repo;
  const reference = new Reference({reveal: (path, line, write) => { if (repo) ctx.openRepo(repo, path, write ?? false, undefined, line ?? 0); }}, {band: true});
  reference.search.querySelector('form')?.prepend(mark('search'));
  const aim = (name: string | null) => { repo = name; reference.setRepo(name); reference.named(name); };
  aim(repo);
  // Forge's band, tool for tool, so the frame is one frame between the two: >_ to the terminal of the repo last worked
  // in, the files button to its file deeds there (New, Rename, Delete), then the search.
  const tool = (name: MarkName, label: string, press: () => void) => {
    const b = h('button', {type: 'button', class: 'band-tool', 'aria-label': label, title: label}, mark(name));
    b.addEventListener('click', press);
    return b;
  };
  const inForge = (ask: 'termNext' | 'deedsNext') => () => {
    const at = repo;
    if (at) void import('../forge/forge.ts').then((f) => { f[ask](); ctx.openRepo(at); });
  };
  const band = h('div', {class: 'home-band'}, h('div', {class: 'band-tools', role: 'group', 'aria-label': t('Tools')},
    tool('term', t('Terminal'), inForge('termNext')), tool('new-file', t('Files: New, Rename, Delete'), inForge('deedsNext')), reference.search));
  const pane = h('div', {class: 'home-pane'}, side, toggle);
  // None worked in yet (or it is gone): the one changed last (the first of the cards' list, read once for both), so the
  // box is never there to be pressed for nothing.
  void listed.then((all) => { if (all && pane.isConnected && !(repo && all.some((r) => r.name === repo))) aim(all[0]?.name ?? null); });
  const layout = h('div', {class: 'home-layout'}, band, main, pane);
  // What the search finds drops as Forge's does, across the column under the band (forge-band.css): measured, it knows
  // how wide and tall that is and where the box stands in it.
  new ResizeObserver(() => {
    const at = band.getBoundingClientRect();
    layout.style.setProperty('--center-w', `${band.clientWidth}px`);
    layout.style.setProperty('--center-h', `${window.innerHeight - at.bottom}px`);
    layout.style.setProperty('--search-x', `${reference.search.getBoundingClientRect().left - at.left}px`);
  }).observe(band);
  // The keys Forge and Git know, here too: Ctrl+K or Ctrl+P (or Ctrl+Shift+F) to the search; Ctrl+B to put the pane
  // away or bring it back (⌘ on a Mac).
  const keys = (event: KeyboardEvent) => {
    if (!layout.isConnected) { document.removeEventListener('keydown', keys); return; }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing || document.getElementById('page')?.hasAttribute('inert')) return;
    const k = event.key.toLowerCase();
    if ((k === 'k' || k === 'p') && !event.shiftKey || (k === 'f' && event.shiftKey)) { event.preventDefault(); reference.findNow(); }
    else if (k === 'b' && !event.shiftKey) { event.preventDefault(); setRightPane(!rightPaneOpen()); }
  };
  document.addEventListener('keydown', keys);
  let was = rightPaneOpen();
  // While it is put away or brought out, its side stays as wide as it is out (styles.css .pane-moving): it goes with
  // its edge and is cut at the window's, as Forge's does, never squeezed as the pane narrows or widens.
  let moving: Animation | null = null;
  const held = () => {
    const w = side.offsetWidth;
    if (!rightPaneOpen() || layout.classList.contains('pane-moving') || !w) return;
    if (pane.style.getPropertyValue('--side-held') !== `${w}px`) pane.style.setProperty('--side-held', `${w}px`);
  };
  new ResizeObserver(held).observe(side);
  const paint = () => {
    const open = rightPaneOpen();
    // Brought back before it had gone: what it holds is still there, and stays.
    const there = layout.isConnected && getComputedStyle(side).visibility === 'visible';
    if (open !== was && layout.isConnected && !still()) {
      // Never out yet at this width: as wide as it will be out, measured before it sets off.
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
    if (open && !was && layout.isConnected) paneOut(side, toggle, null, !there);
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
  arrowKeys(list, '.pane-row');
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
      rows.push(latelyRow(shownName(left.path), t('{repo} · Continue where you left off', {repo: left.repo}), {quote, place: left.repo, go: goOn}));
    }
    // The servers and the conversations asked at once: neither waits on the other (one round to the Remote, not two).
    const [all, threads] = connection()
      ? await Promise.all([servers.servers().catch(() => []), inbox.threads().catch(() => [])])
      : [[], []];
    if (connection()) {
      for (const th of waiting(threads, 3)) {
        const who = th.name || inbox.shown(th.address);
        const answer = () => { openNext(th.address); void ctx.go('inbox'); };
        rows.push(latelyRow(who, wordLine(th), {fresh: true, go: answer}));
      }
      for (const b of news().boards.slice(0, 3)) {
        const s = all.find((x) => x.id === b.server);
        const board = s?.boards.find((x) => x.id === b.id);
        if (!s || !board) continue;
        const there = () => {
          remember({server: s.id, board: board.id});
          void ctx.go('server');
        };
        rows.push(latelyRow(board.name, t('{server} · New posts', {server: s.name}), {fresh: true, go: there}));
      }
    }
    // The boards this browser writes in as a guest (none of its servers'): where one writes, a way back always,
    // signed in or not; its look reads the board and writes in it as the guest.
    const ours = new Set(all.flatMap((s) => s.boards.map((x) => x.id)));
    for (const {id, here} of servers.guestBoards().filter((g) => !ours.has(g.id)).slice(0, 3)) {
      const there = () => { remember({board: id}); void ctx.go('server'); };
      rows.push(latelyRow(here.name, t('{server} · Joined as guest', {server: here.server}), {go: there}));
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

/**
 * The name on its one line, at the size a name is said at (styles: --t-name, about a place of the rail's beside it);
 * one longer than its line breaks instead, balanced over its lines.
 */
function fitName(header: HTMLElement) {
  const name = header.querySelector<HTMLElement>('.identity > h1'), room = header.parentElement?.clientWidth ?? 0;
  if (!name) return;
  const fits = fitSize(name, name.textContent ?? '', room, -.04, () => fitName(header));
  if (fits) name.classList.toggle('long', fits < parseFloat(getComputedStyle(name).fontSize));
}

/**
 * A line written where it is read: pressed, the caret is in it, with nothing drawn round it. Enter keeps what is
 * written (`kept`, told only when it changed), Escape leaves it as it was; the keyboard gone elsewhere keeps it too.
 * At most `most` characters; `lines`: Enter with Shift is a new line in it.
 */
function written(el: HTMLElement, o: {most: number; lines?: boolean; begun?: () => void; kept: (text: string, was: string) => void}) {
  el.contentEditable = 'plaintext-only';
  if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
  el.spellcheck = false;
  let was = '';
  el.addEventListener('focus', () => { o.begun?.(); was = el.textContent ?? ''; });
  el.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !(o.lines && e.shiftKey)) { e.preventDefault(); el.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); el.textContent = was; el.blur(); }
  });
  // Only its words are taken in: what is pasted comes as text.
  el.addEventListener('paste', (e) => {
    e.preventDefault();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    getSelection()?.getRangeAt(0).deleteContents();
    getSelection()?.getRangeAt(0).insertNode(document.createTextNode(o.lines ? text : text.replace(/\s+/g, ' ')));
    getSelection()?.collapseToEnd();
    el.dispatchEvent(new Event('input', {bubbles: true}));
  });
  el.addEventListener('input', () => {
    const text = el.textContent ?? '';
    if ([...text].length <= o.most) return;
    el.textContent = [...text].slice(0, o.most).join('');
    getSelection()?.selectAllChildren(el);
    getSelection()?.collapseToEnd();
  });
  el.addEventListener('blur', () => {
    const now = (el.textContent ?? '').trim();
    // (A line left with nothing in it holds nothing, not a line feed a browser leaves there: its placeholder shows.)
    if (!now) el.textContent = '';
    if (now !== was.trim()) o.kept(now, was);
  });
}

/**
 * The profile at Home's top, written where it is read. The name is the line it is written on, where it stands and as
 * large: pressed, the caret is in it; there is no sheet, no Cancel and no Save. Signed in, the handle after it is
 * written the same way (it is the username: changed here it is changed on the Remote first, and one that cannot be
 * is said under it, nothing kept). The line about the person is under the name while it says something. Where there
 * is none, the way to write one stands after the name, on its line, only while the name has the keyboard: pressed,
 * the line opens under the name to be written, and left empty it closes. Nothing under the profile moves as the name
 * is pressed or left (a press on what is under it would miss as it moved). At the line's right end, the counts.
 */
function profileHeader(count: HTMLElement, owner: boolean): HTMLElement {
  const name = h('h1', {id: 'profile-name', 'data-placeholder': t('Your name')});
  const handleIn = h('span', {id: 'profile-handle', class: 'handle-in', role: 'textbox', 'aria-label': t('Handle'), 'data-placeholder': t('handle')});
  const handle = h('p', {class: 'handle'}, '@', handleIn);
  const bio = h('p', {id: 'profile-bio', class: 'bio', role: 'textbox', 'aria-label': t('Bio'), 'data-placeholder': t('Short bio')});
  const bioAsk = h('button', {type: 'button', class: 'bio-ask'}, t('Short bio'));
  const said = h('p', {class: 'error', role: 'alert'});
  // Each count is the way to what it counts (as a profile's counts are): pressed, there it is.
  const counts = h('p', {class: 'counts'}, toSection(count, 'repos-title'), toSection(servers0(), 'servers-title'));
  const identity = h('div', {class: 'identity'}, name, handle, bio, owner ? bioAsk : null, counts, said);
  const header = h('section', {class: 'profile'}, identity);
  /** The name the person signed in with and their username there, once known ('' signed out, or not yet). */
  let account = {name: '', user: ''};
  /** What stands in for a name where none is written: the handle. Pressed, the line is empty to write a name on. */
  let standsIn = false;
  const writing = () => identity.contains(document.activeElement);
  const paint = () => {
    const p = currentProfile(), called = p.name || account.name, user = account.user || p.handle;
    standsIn = !called && !!user;
    name.textContent = called || (user ? `@${user}` : '');
    handleIn.textContent = user;
    handle.hidden = !user || standsIn;
    bio.textContent = p.bio;
    said.textContent = '';
    fitName(header);
  };
  paint();
  // Signed in, one person, one name: none written here yet, it is the one signed in with (the Remote's); and the
  // handle is their username there, the one name others find them by, kept on the profile too as it changes.
  void Promise.all([myName().catch(() => ''), inbox.myUsername().catch(() => '')]).then(([called, user]) => {
    account = {name: called, user};
    if (!writing()) paint();
    // Onto the profile as it is now, not as it was drawn (it may have come in from the Remote meanwhile, and was
    // written over), signed in still, and not while it is being taken off this device (it came back then, after Remove
    // from device).
    const now = currentProfile();
    if (user && user !== now.handle && connection() && !homeIsHeld()) void setState('profile', JSON.stringify({...now, handle: user})).catch(() => {});
  });
  if (owner) {
    const keep = async (next: Partial<Profile>, at: HTMLElement) => {
      said.textContent = '';
      const result = normalize({...currentProfile(), ...next});
      // Said under it, the keyboard back in the line; left again as it is, the line says what is kept, not what was not.
      const refused = (why: string) => {
        said.textContent = why;
        at.focus();
        nudge(at);
        at.addEventListener('blur', () => { queueMicrotask(() => { if (said.textContent === why) paint(); }); }, {once: true});
      };
      if (result.error) { refused(t('Handle must be 2–31 lowercase letters, digits, or . - _')); return; }
      // Their username changed on the Remote first: taken, or changed too often, it is said under it. Left empty, it
      // is as it was (a username is changed, never taken away).
      if (next.handle !== undefined && connection()) {
        if (!result.profile.handle) result.profile.handle = account.user;
        else if (result.profile.handle !== account.user) {
          try { result.profile.handle = account.user = await inbox.changeUsername(result.profile.handle); } catch (e) { refused(errorText(e)); return; }
        }
      }
      try { await setState('profile', JSON.stringify(result.profile)); } catch (e) { said.textContent = t('Failed to save: {message}', {message: errorText(e)}); return; }
      // Signed in, the name is the account's too: what is started, committed and reviewed from here says it.
      if (next.name !== undefined && result.profile.name) {
        account.name = result.profile.name;
        try { await rename(result.profile.name); } catch (e) { said.textContent = t('Saved locally; Remote name unchanged ({message})', {message: errorText(e)}); return; }
      }
      if (!writing()) paint();
    };
    written(name, {most: LIMITS.name, begun: () => { if (standsIn) { name.textContent = ''; standsIn = false; } },
      kept: (text) => { if (text) void keep({name: text}, name); else paint(); }});
    name.addEventListener('input', () => fitName(header));
    name.addEventListener('blur', () => { if (!name.textContent) paint(); });
    if (connection()) written(handleIn, {most: LIMITS.handle + 1, kept: (text) => void keep({handle: text}, handleIn)});
    written(bio, {most: LIMITS.bio, lines: true, kept: (text) => void keep({bio: text}, bio)});
    // The line about the person opened to be written; left with nothing on it, it closes. Left by a press, it closes
    // once the press is over: what is under the profile does not move from under the pointer on its way down.
    let pressing = false;
    addEventListener('pointerdown', () => { pressing = true; }, true);
    for (const up of ['pointerup', 'pointercancel'] as const) addEventListener(up, () => { pressing = false; }, true);
    // (Pressed, the keyboard stays in the name until the line is open: the way to it is there only while it is.)
    bioAsk.addEventListener('mousedown', (e) => e.preventDefault());
    bioAsk.addEventListener('click', () => { identity.classList.add('bio-open'); bio.focus(); });
    bio.addEventListener('blur', () => {
      const close = () => { if (document.activeElement !== bio) identity.classList.remove('bio-open'); };
      if (pressing) addEventListener('click', () => setTimeout(close), {once: true, capture: true}); else close();
    });
  }
  // As wide as Home's column, the name as large as that lets it be: fitted again as the column narrows or widens
  // (not as the name's size makes the profile taller).
  let wide = 0;
  new ResizeObserver(() => {
    const w = header.parentElement?.clientWidth ?? 0;
    if (w !== wide) { wide = w; fitName(header); }
  }).observe(header);
  // Kept elsewhere meanwhile (the Remote's, taken in as one signs in; root3; another tab): drawn as it is now, unless it
  // is being written.
  const stop = onState((key, outside) => {
    if (key !== 'profile' || !outside) return;
    if (!header.isConnected) { stop(); return; }
    if (!writing()) paint();
  });
  return header;
}

