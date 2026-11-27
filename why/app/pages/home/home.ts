import {openNext} from '../kit/next.ts';
import {agentCards} from '../kit/agent-cards.ts';
import {arrowKeys, h} from '../../ui/dom.ts';
import {t, tn} from '../../../text/i18n.ts';
import {LIMITS, normalize, parse, type Profile} from '../../../home/profile.ts';
import {connection, myName, onConnection, rename} from '../../../shipto/connection.ts';
import {getState, onState, setState, settingName, unreadable} from '../../../home/state.ts';
import * as servers from '../../../shipto/servers.ts';
import * as inbox from '../../../shipto/inbox.ts';
import {news, onNews} from '../../../shipto/news.ts';
import {onRenamed, store, type RepoSummary} from '../../../repo/repos.ts';
import {homeIsHeld} from '../../../shipto/lifecycle.ts';
import {shownName} from '../../../repo/issues.ts';
import {repoList} from './repo-list.ts';
import {recentGlass} from './recent-glass.ts';
import {RecentSnapshot, recentScope} from './recent.ts';
import {todoBox} from '../kit/todo-list.ts';
import {remember} from '../server/parts.ts';
import type {Context} from '../kit/context.ts';
import {latelyRow, pluginArea, waiting, wordLine} from '../kit/pane.ts';
import {inkEdge} from '../../ui/optical.ts';
import {wholeCells} from '../../ui/row.ts';
import {errorText} from '../../../api/errors.ts';
import {nudge} from '../../ui/glide.ts';
import {whole} from '../../ui/whole.ts';
import {deskSearch, placesMenu} from '../kit/places.ts';

/** The profile as it stands (Home's state, see state.ts), for Home and the rail's own icon. */
export const currentProfile = (): Profile => parse(getState('profile'));

/** Open Home with the caret in the name, to write it. */
export function startEditing(ctx: Context) {
  void ctx.go('home').then(() => document.getElementById('profile-name')?.focus());
}

/**
 * Home: the person's name as large as Home is wide, and under it what is theirs to do beside where it is done: the
 * TODO, a box as Forge's are, and the repos by name, each pressed to go there.
 */
export function home(ctx: Context): Node[] {
  const owner = true;
  const count = h('span', {});
  const list = repoList(ctx, {newCard: true, brief: true, counted: (n) => counting(count, n, 'repo', 'repos')});
  // (Home is not seen before its repos are drawn: ui/whole.ts.)
  const listed = whole(list.refresh());
  const grid = list.element;
  // Names set beside their label (home.css); New repo's list and other grids stay cards.
  grid.classList.add('home-repos');
  const header = profileHeader(count, owner, ctx);
  // A setting that could not be read is said here, where the person looks first; it is not written over meanwhile.
  const unread = [...unreadable()].map(([k, why]) => h('p', {class: 'error', role: 'alert'}, t('Could not read {what} ({why})', {what: settingName(k), why})));
  // Against the right edge, the repos by name; at its foot what waits (the plug's area and an agent's cards over it
  // while there are any). The servers are a count that goes to Server, where they are.
  const repos = h('section', {class: 'section home-repos-sec', 'aria-labelledby': 'repos-title'}, h('h2', {id: 'repos-title'}, t('Repos')), grid);
  const waits = h('div', {class: 'home-waits'}, lately(ctx), pluginArea(), agentCards((repo, issue) => {
    void import('../git/git.ts').then((g) => { g.showIssue(repo, issue.replace(/^issue\//, '')); void ctx.go('git'); });
  }));
  const beside = h('div', {class: 'home-beside'}, repos, waits);
  const note = todoBox();
  // Home's own things are pieces on its desk: the person's (name and note), then the repos and what waits. They are
  // short, so they are set as words are (home.css): along, and what does not fit beside the last goes under it.
  const own = h('div', {class: 'home-own'}, h('div', {class: 'home-person'}, header, ...unread), note);
  const main = h('div', {class: 'home-main home-row'}, own, beside);
  // The note and the slip are whole cells tall, whatever is written on them: what is under them stays on the grid.
  wholeCells(note);
  for (const slip of waits.children) wholeCells(slip as HTMLElement);
  // The names' ink stands on the column's left edge. Fixed rank does not shrink when a longer name is given.
  const edges = () => {
    for (const el of beside.querySelectorAll<HTMLElement>('.home-repos .card-title')) inkEdge(el, 'left');
    alignName(header);
  };
  new MutationObserver(edges).observe(beside, {childList: true, subtree: true, characterData: true});
  const sized = new ResizeObserver(edges);
  sized.observe(repos); sized.observe(header);
  return [portrait(main, ctx, listed)];
}

/** Home is not a toolbar. The common corner keys leave its writing at rest. */
function portrait(main: HTMLElement, ctx: Context, listed: Promise<RepoSummary[] | null>): HTMLElement {
  const layout = h('div', {class: 'home-layout home-portrait'}, main);
  let repo = ctx.repo;
  void listed.then((repos) => {
    if (repos && !repos.some((r) => r.name === repo)) repo = repos[0]?.name ?? null;
  });
  const find = deskSearch(ctx, () => repo);
  const places = placesMenu(layout, ['Home'], 'Home', () => {}, () => {
    const at = repo;
    return [
      {label: 'Forge', run: () => void ctx.go('forge')},
      {label: 'Git', run: () => void ctx.go('git')},
      {label: 'Server', run: () => void ctx.go('server')},
      {label: 'Inbox', run: () => void ctx.go('inbox')},
      {label: 'Remote', run: () => void ctx.go('remote')},
      {label: 'Runtime', run: () => void ctx.go('runtime')},
      ...(at ? [
        {label: 'Prompt', run: () => { void import('../forge/forge.ts').then((f) => { f.termNext(); ctx.openRepo(at); }); }},
      ] : []),
      ...(ctx.placeCommands?.(['home', 'forge', 'server', 'runtime', 'new-repo']) ?? []),
    ];
  }, {find});
  function keys(event: KeyboardEvent) {
    if (!layout.isConnected) { document.removeEventListener('keydown', keys); return; }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing || layout.closest('[inert]')) return;
    const k = event.key.toLowerCase();
    if (((k === 'k' || k === 'p') && !event.shiftKey) || (k === 'f' && event.shiftKey)) {
      event.preventDefault();
      places.close();
      find(document.activeElement);
    }
  }
  document.addEventListener('keydown', keys);
  return layout;
}

/**
 * What waits since the person was last here, in Home's pane, each leading there: where they left off (the file last
 * read in Forge, to go on writing in), the conversations with something not read, the boards with posts not seen,
 * and the boards they write in as a guest.
 * With nothing new it says so, quietly: the pane out is never a line with nothing beside it.
 */
type Recent =
  | {kind: 'file'; left: NonNullable<Context['leftOff']>; quote: string | undefined}
  | {kind: 'letter'; thread: inbox.Thread}
  | {kind: 'board'; board: string; name: string; room: string; server?: string};

// Keep data, not the previous desk's buttons, and invalidate it even while Home is not on screen.
const recent = new RecentSnapshot<Recent[]>();
let rejoinRecent: ((scope: string | null) => void) | undefined;
function recentIdentityChanged() {
  const scope = recentScope(connection());
  recent.read(scope);
  rejoinRecent?.(scope);
}
onConnection(recentIdentityChanged);
onState((key) => { if (key === 'remote') recentIdentityChanged(); });

function recentRow(row: Recent, ctx: Context) {
  switch (row.kind) {
    case 'file': {
      const {left, quote} = row;
      const key = latelyRow(shownName(left.path), t('{repo} · Continue where you left off', {repo: left.repo}), {
        quote, heard: !quote, place: left.repo,
        go: () => ctx.openRepo(left.repo, left.path, left.at === null ? 'end' : {at: left.at}),
      });
      key.classList.add('pane-resume');
      return key;
    }
    case 'letter': {
      const {thread} = row;
      return latelyRow(thread.name || inbox.shown(thread.address), wordLine(thread), {
        fresh: true, go: () => { openNext(thread.address); void ctx.go('inbox'); },
      });
    }
    case 'board':
      return latelyRow(row.name, row.server ? t('{server} · New posts', {server: row.room}) : t('{server} · Joined as guest', {server: row.room}), {
        fresh: !!row.server, go: () => { remember({server: row.server, board: row.board}); void ctx.go('server'); },
      });
  }
}

function lately(ctx: Context): HTMLElement {
  const list = h('div', {class: 'lately-list'});
  arrowKeys(list, '.pane-row');
  const box = h('section', {class: 'lately', 'aria-labelledby': 'lately-title'}, recentGlass(), h('h2', {id: 'lately-title'}, t('Recent activity')), list);
  const show = (rows: Recent[] | undefined) => list.replaceChildren(...(rows?.length ? rows.map((row) => recentRow(row, ctx))
    : rows ? [h('p', {class: 'muted small lately-none'}, t('Nothing new'))] : []));
  let shown = recentScope(connection());
  show(recent.read(shown));
  const take = (scope: string | null) => {
    if (scope === shown) return false;
    shown = scope;
    show(recent.read(scope));
    return true;
  };
  const paint = async () => {
    const now = () => { const scope = recentScope(connection()); take(scope); return scope; };
    const scope = now(), mine = recent.begin(scope);
    const rows: Recent[] = [];
    const left = ctx.leftOff;
    if (left && (await store.names().catch((): string[] => [])).includes(left.repo)) {
      // The line it was left at, as it is now: what was being written, to be taken up again; or the nearest above it
      // with a word in it (a closing brace alone says nothing of where one was).
      const text = left.at === null ? null : (await store.read(left.repo, left.path).catch(() => null))?.text ?? null;
      const end = text === null || left.at === null ? -1 : text.indexOf('\n', left.at);
      const quote = text === null ? '' : text.slice(0, end < 0 ? text.length : end).split('\n').reverse().find((l) => /[\p{L}\p{N}]/u.test(l))?.trim() ?? '';
      // A line that only says the names (a README's title is often its repo's) says nothing of where one was.
      const names = [left.repo, shownName(left.path), left.path.split('/').pop() ?? ''].map((n) => n.toLowerCase());
      const telling = !!quote && !names.includes(quote.replace(/^[\s#/*>;-]+|[\s*/;]+$/g, '').toLowerCase());
      rows.push({kind: 'file', left, quote: telling ? quote : undefined});
    }
    if (!recent.current(now(), mine)) return;
    // Reply and board reads share one generation and never wait on one another.
    const [all, threads] = scope !== null
      ? await Promise.all([servers.servers().catch(() => []), inbox.threads().catch(() => [])])
      : [[], []];
    // Even a synchronous signed-out read belongs to a mounted desk, not one removed during the read.
    await Promise.resolve();
    if (!box.isConnected || !recent.current(now(), mine)) return;
    for (const thread of waiting(threads, 3)) {
      // Only the first line is drawn. The rest of the message does not belong in this cache.
      rows.push({kind: 'letter', thread: {...thread, last: {...thread.last, body: thread.last.body.split('\n', 1)[0]}}});
    }
    if (scope !== null) for (const b of news().boards.slice(0, 3)) {
      const s = all.find((x) => x.id === b.server);
      const board = s?.boards.find((x) => x.id === b.id);
      if (s && board) rows.push({kind: 'board', server: s.id, board: board.id, name: board.name, room: s.name});
    }
    // A board this device writes in as a guest is available whether or not the device is signed in.
    const ours = new Set(all.flatMap((s) => s.boards.map((x) => x.id)));
    for (const {id, here} of servers.guestBoards().filter((g) => !ours.has(g.id)).slice(0, 3)) {
      rows.push({kind: 'board', board: id, name: here.name, room: here.server});
    }
    if (recent.keep(now(), mine, rows)) show(rows);
  };
  rejoinRecent = (scope) => {
    if (!box.isConnected) { rejoinRecent = undefined; return; }
    if (take(scope)) queueMicrotask(() => { if (box.isConnected) void paint(); });
  };
  // (Home is not seen before what waits is read: ui/whole.ts.)
  void whole(paint());
  list.addEventListener('look-closed', () => void paint());
  const off = onNews(() => { if (!box.isConnected) { off(); return; } void paint(); });
  // A repo renamed: where one left off says it under its new name.
  const offRenamed = onRenamed(() => { if (!box.isConnected) { offRenamed(); return; } void paint(); });
  return box;
}

/** A count that goes to its section (`title` its heading's id): scrolled to, its heading lit as it lands. */
function toSection(count: HTMLElement, title: string): HTMLElement {
  const b = h('button', {type: 'button', class: 'count-go'}, count);
  b.addEventListener('click', () => {
    const head = document.getElementById(title);
    if (!head) return;
    head.closest('section')?.scrollIntoView({block: 'start'}); // (at once, DESIGN §8)
    head.classList.remove('landed'); void head.offsetWidth; head.classList.add('landed');
  });
  return b;
}

/** The servers' count goes to Server, where they are. */
function toServer(count: HTMLElement, ctx: Context): HTMLElement {
  const b = h('button', {type: 'button', class: 'count-go'}, count);
  b.addEventListener('click', () => void ctx.go('server'));
  return b;
}

/** How many servers there were when they were last counted: a redraw says it at once, then as it is now. */
let serversWere = 0;
const servers0 = () => {
  const el = h('span', {id: 'server-count'});
  if (!connection()) serversWere = 0;
  counting(el, serversWere, 'server', 'servers');
  if (connection()) void whole(servers.servers()).then((list) => { serversWere = list.length; counting(el, list.length, 'server', 'servers'); }, () => {});
  return el;
};

/** A count and its word: one repo, 2 repos (Japanese tells them apart by the number alone). */
function counting(el: HTMLElement, n: number, one: string, many: string) {
  el.replaceChildren(h('b', {}, String(n)), ' ', tn(one, many, n));
}

/** The ink, not the box, begins at the column's edge. CSS keeps the name's size while it wraps. */
function alignName(header: HTMLElement) {
  const name = header.querySelector<HTMLElement>('.identity > h1');
  if (name) inkEdge(name, 'left');
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

/** Where the account's name and username are kept as last heard, for the session they were heard in. */
const ACCOUNT_KEY = 'why.account';
const accountOf = () => { const c = connection(); return c ? c.user || c.session : ''; };

/** The account's name and username as last heard for this session: Home drawn again, or the OS opened again, says
 * them at once, never a moment of the handle or "Your name" standing in for the name. */
function knownAccount(): {name: string; user: string} {
  const who = accountOf();
  try {
    const k = JSON.parse(localStorage.getItem(ACCOUNT_KEY) ?? 'null') as {who?: string; name?: string; user?: string} | null;
    if (who && k?.who === who) return {name: String(k.name ?? ''), user: String(k.user ?? '')};
  } catch { /* none kept */ }
  return {name: '', user: ''};
}
function keepAccount(a: {name: string; user: string}) {
  const who = accountOf();
  try { if (who) localStorage.setItem(ACCOUNT_KEY, JSON.stringify({who, ...a})); } catch { /* said again next time */ }
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
function profileHeader(count: HTMLElement, owner: boolean, ctx: Context): HTMLElement {
  const name = h('h1', {id: 'profile-name', 'data-placeholder': t('Your name')});
  const handleIn = h('span', {id: 'profile-handle', class: 'handle-in', role: 'textbox', 'aria-label': t('Handle'), 'data-placeholder': t('handle')});
  const handle = h('p', {class: 'handle'}, '@', handleIn);
  const bio = h('p', {id: 'profile-bio', class: 'bio', role: 'textbox', 'aria-label': t('Bio'), 'data-placeholder': t('Short bio')});
  const bioAsk = h('button', {type: 'button', class: 'bio-ask'}, t('Short bio'));
  const said = h('p', {class: 'error', role: 'alert'});
  // Each count is the way to what it counts (as a profile's counts are): pressed, there it is.
  const counts = h('p', {class: 'counts'}, toSection(count, 'repos-title'), toServer(servers0(), ctx));
  const identity = h('div', {class: 'identity'}, name, handle, bio, owner ? bioAsk : null, counts, said);
  const header = h('section', {class: 'profile'}, identity);
  /** The name the person signed in with and their username there, as last known ('' signed out, or not yet). */
  let account = knownAccount();
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
    alignName(header);
  };
  paint();
  // Signed in, one person, one name: none written here yet, it is the one signed in with (the Remote's); and the
  // handle is their username there, the one name others find them by, kept on the profile too as it changes.
  // (Home is not seen before they are known, ui/whole.ts; known before, they are said at once.)
  void whole(Promise.all([myName().catch(() => ''), inbox.myUsername().catch(() => '')])).then(([called, user]) => {
    // (Not heard, they are as last known: the Remote away does not take the name off the page.)
    account = {name: called || account.name, user: user || account.user};
    keepAccount(account);
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
          try { result.profile.handle = account.user = await inbox.changeUsername(result.profile.handle); keepAccount(account); } catch (e) { refused(errorText(e)); return; }
        }
      }
      try { await setState('profile', JSON.stringify(result.profile)); } catch (e) { said.textContent = t('Failed to save: {message}', {message: errorText(e)}); return; }
      // Signed in, the name is the account's too: what is started, committed and reviewed from here says it.
      if (next.name !== undefined && result.profile.name) {
        account.name = result.profile.name;
        keepAccount(account);
        try { await rename(result.profile.name); } catch (e) { said.textContent = t('Saved locally; Remote name unchanged ({message})', {message: errorText(e)}); return; }
      }
      if (!writing()) paint();
    };
    written(name, {most: LIMITS.name, begun: () => { if (standsIn) { name.textContent = ''; standsIn = false; } },
      kept: (text) => { if (text) void keep({name: text}, name); else paint(); }});
    name.addEventListener('input', () => alignName(header));
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
  // Kept elsewhere meanwhile (the Remote's, taken in as one signs in; why; another tab): drawn as it is now, unless it
  // is being written.
  const stop = onState((key, outside) => {
    if (key !== 'profile' || !outside) return;
    if (!header.isConnected) { stop(); return; }
    if (!writing()) paint();
  });
  return header;
}

