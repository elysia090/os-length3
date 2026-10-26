import {day, h} from '../../ui/dom.ts';
import {t, tn} from '../../i18n.ts';
import {shown as named, shownAs} from '../../remote/inbox.ts';
import * as servers from '../../remote/servers.ts';
import {deed, parts, type Parts} from '../common.ts';
import {every} from '../../app/runs.ts';
import {askIn, boardName, button, foot, footLeft, line, MOVE, smallCard} from './parts.ts';
import {guestsCard} from './guests.ts';
import {errorText} from '../../app/errors.ts';
import {personBadge} from '../pane.ts';

// Behind the gear: what changes the server for everyone. In parts, as
// Remote's page is (its people, the repos shown, its boards, the server
// itself): a small card for each thing, what can be done with it at its
// foot, and what reaches past its people asked in the card.

type Part = 'people' | 'repos' | 'boards' | 'server';

/** What the gear needs of the layer it is in. */
export interface GearWays {
  /** The boards' place, where the gear's sheet goes. */
  sheet: HTMLElement;
  /** Still behind the gear of this server: a reading that comes after it is put away is dropped. */
  still(): boolean;
  /** Done: back to the boards. */
  done(): void;
  /** Something changed: the gear and the side are drawn again. */
  again(): void;
  /** How many people and repos the pane last drew for this server, if it has: the parts' counts at once. */
  known(): {people: number; repos: number} | null;
  /** A board was removed or brought back: the boards are built again on the way back to them. */
  boardsChanged(): void;
  /** One left the server, or removed it: the next one, or making one. */
  gone(id: string): void;
  isMe(address: string): Promise<boolean>;
}

/** What each part is drawn from: the server, what was read of it, and who one is among its people (`mine`). */
interface Read {
  s: servers.Server;
  w: GearWays;
  people: servers.Person[];
  repos: servers.ShownRepo[];
  mineAll: servers.RepoSeen[];
  mine: string | null;
}

export async function gear(s: servers.Server, w: GearWays): Promise<void> {
  const tabs = sheet(s, w);
  // The counts as the pane last drew them, at once: the parts' names do not step sideways when the reading comes.
  tabs.count('boards', s.boards.filter((b) => !b.gone).length);
  const known = w.known();
  if (known) { tabs.count('people', known.people); tabs.count('repos', known.repos); }
  const grid = (k: Part, ...cards: (Node | null)[]) => tabs.panel(k).replaceChildren(h('div', {class: 'grid small-grid'}, ...cards));
  try {
    const [people, repos, mineAll] = await Promise.all([servers.people(s.id), servers.shownIn(s.id), servers.seenAll()]);
    if (!w.still()) return;
    tabs.count('people', people.length);
    tabs.count('repos', repos.length);
    const mine = (await Promise.all(people.map(async (p) => ((await w.isMe(p.address)) ? p.address : null)))).find(Boolean) ?? null;
    const r: Read = {s, w, people, repos, mineAll, mine};
    grid('people', ...people.map((p) => personCard(r, p)), addSomeone(r));
    grid('repos', ...repoCards(r));
    grid('boards', ...s.boards.flatMap((b) => boardCards(r, b)));
    grid('server', ...serverCards(r));
    keepPeople(r, tabs);
  } catch (e) { tabs.panel(tabs.current()).replaceChildren(h('p', {class: 'error'}, errorText(e))); }
}

/** How often its people are looked at again behind the gear, as the pane does. */
const EVERY = 15_000;

/**
 * While one is behind the gear, its people are looked at again every little while: someone asked in who accepts on
 * their own device comes into People (and its count) then. Only the people's cards are drawn again (the card that
 * adds, and what is written in it, stays), and not while one of them asks or has the keyboard.
 */
function keepPeople(r: Read, tabs: Parts<Part>) {
  const panel = tabs.panel('people');
  let drawn = JSON.stringify(r.people);
  every(EVERY, async () => {
    if (panel.querySelector('.person-card .off-ask, .person-card:focus-within')) return;
    const now = await servers.people(r.s.id);
    if (!r.w.still() || JSON.stringify(now) === drawn) return;
    drawn = JSON.stringify(now);
    r.people = now;
    tabs.count('people', now.length);
    const grid = panel.querySelector('.grid');
    if (!grid) return;
    for (const c of grid.querySelectorAll('.person-card')) c.remove();
    grid.prepend(...now.map((p) => personCard(r, p)));
  }, {alive: () => panel.isConnected && r.w.still(), paced: true});
}

/** The sheet in the boards' place: the server's name and code at its head, its parts, and Done at its foot. */
function sheet(s: servers.Server, w: GearWays): Parts<Part> {
  const done = button(t('Done'), 'small-button');
  done.addEventListener('click', () => w.done());
  const tabs = parts<Part>('server-gear', [{id: 'people', label: t('People')}, {id: 'repos', label: t('Repos')}, {id: 'boards', label: t('Boards')}, {id: 'server', label: t('This server')}]);
  const ids: Part[] = ['people', 'repos', 'boards', 'server'];
  // Done is the sheet's answer, so it is at its bottom right (DESIGN.md §3, Where a deed sits), under what scrolls:
  // found at the same place however long a part is, and on a phone too.
  w.sheet.replaceChildren(
    h('div', {class: 'sheet-head'}, h('div', {class: 'sheet-title'}, h('h2', {}, s.name), h('p', {}, `${named(s.address)} · ${s.code}`))),
    h('div', {class: 'sheet-body'}, tabs.switch, ...ids.map((k) => tabs.panel(k))),
    h('div', {class: 'sheet-foot'}, h('span', {class: 'grow'}), done));
  // Narrow, the parts slide: the one chosen is kept in view.
  const inView = () => tabs.switch.querySelector('[aria-selected="true"]')?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  tabs.onShow(inView);
  requestAnimationFrame(inView);
  return tabs;
}

/** What asking before a deed says: its lines, and the deed's word. */
interface Ask { what: string | string[]; verb: string }

/**
 * A setting in a card: its word and a switch. Widening asks in the card first; narrowing is at once, unless it ends
 * something that cannot be had back by turning it on again (`narrowing` says what, read as it is pressed: a board's
 * guests and invitations), when it asks in the card too.
 */
function setting(w: GearWays, card: HTMLElement, label: string, on: boolean, ask: Ask, change: (v: boolean) => Promise<unknown>,
  narrowing?: () => Promise<Ask | null>) {
  const sw = h('button', {type: 'button', class: 'power plain', role: 'switch', 'aria-checked': String(on), 'aria-label': label}, h('span', {class: 'knob'})) as HTMLButtonElement;
  // It moves on the press, green when on; widening then asks in the card (no puts it back), narrowing is at once.
  const to = (v: boolean) => sw.setAttribute('aria-checked', String(v));
  const said = h('span', {class: 'error small', role: 'alert'});
  const title = () => card.querySelector('.card-title')?.textContent ?? '';
  sw.addEventListener('click', async () => {
    to(!on);
    if (!on) {
      window.setTimeout(() => askIn(card, sw, title(), ask.what, ask.verb, async () => { await change(true); w.again(); }, () => to(false)), MOVE);
      return;
    }
    sw.disabled = true;
    // What narrowing ends, read now (not read: it narrows at once, as with nothing to end).
    const moved = new Promise((done) => window.setTimeout(done, MOVE));
    const ends = narrowing ? await narrowing().catch(() => null) : null;
    if (ends) {
      await moved;
      sw.disabled = false;
      askIn(card, sw, title(), ends.what, ends.verb, async () => { await change(false); w.again(); }, () => to(true));
      return;
    }
    // Not narrowed: the switch goes back on, and says why.
    try { await change(false); w.again(); } catch (e) { to(true); sw.disabled = false; said.textContent = errorText(e); }
  });
  return h('div', {class: 'card-row'}, h('span', {class: 'grow'}, label), sw, said);
}

// ---- its people: anyone in it adds someone they know; only its owner takes someone out ----

function personCard({s, w, mine}: Read, p: servers.Person): HTMLElement {
  // Who it is as the side and the talk show them: their round initial on its tint, then their name.
  const c = smallCard(h('span', {class: 'person-title'}, personBadge(named(p.address)), h('span', {}, named(p.address))),
    line(p.owner ? t('owner') : p.address === mine ? t('you') : ''));
  c.classList.add('person-card');
  if (s.owner && p.address !== mine) {
    const out = button(t('Remove'), 'small-button');
    out.addEventListener('click', () => askIn(c, out, named(p.address), t('{who} leaves {server}.', {who: named(p.address), server: s.name}),
      t('Remove'), async () => { await servers.removePerson(s.id, p.address || p.id || ''); w.again(); }));
    c.append(footLeft(out));
  }
  return c;
}

/**
 * Pressed, the dashed card is the card that adds: one's contacts not in it yet, each a press away, and a name or a
 * code for anyone else, asked in the Inbox and in once they accept.
 */
function addSomeone(r: Read): HTMLElement {
  // Its word starts where the people's names start, at the card's own padding (not in its middle).
  const add = h('button', {type: 'button', class: 'card small-card new add-someone'}, t('Add someone you know')) as HTMLButtonElement;
  add.addEventListener('click', async () => {
    const inbox = await import('../../remote/inbox.ts');
    let known: {address: string}[] = [], why = '';
    try { known = (await inbox.threads()).filter((x) => x.state === 'contact' && !r.people.some((p) => p.address === x.address)); } catch (e) { why = errorText(e); }
    const typed = h('input', {class: 'line-in', placeholder: t('A name or a code'), 'aria-label': t('Name or code of someone to add'),
      autocapitalize: 'off', spellcheck: 'false'}) as HTMLInputElement;
    const said = h('p', {class: 'muted small', role: 'status'});
    const ways: servers.AddWays = {
      lookup: (x) => inbox.lookup(x),
      add: (id, address) => servers.addPerson(id, address),
      ask: (address, body, server) => inbox.send(address, body, 'message', {server}),
      // In at once, told so in their Inbox, the message about the server their way to it.
      tell: (address, body, server) => inbox.send(address, body, 'message', {server}),
    };
    const go = addByName(r, typed, said, ways);
    const pick = h('div', {class: 'card small-card add-card'}, h('span', {class: 'card-title'}, t('Add someone you know')),
      ...(why ? [h('p', {class: 'error small'}, why)] : known.map((x) => {
        const b = button(named(x.address), 'small-button');
        deed(b, async () => { await servers.addPerson(r.s.id, x.address); await servers.told(ways, x.address, r.s); r.w.again(); });
        return b;
      })),
      h('div', {class: 'row add-by-name'}, typed, go), said);
    add.replaceWith(pick);
    typed.focus();
  });
  return add;
}

/** Add, for the name or code `typed`: in at once, or asked in the Inbox, as `said` then says. */
function addByName({s, w, people}: Read, typed: HTMLInputElement, said: HTMLElement, ways: servers.AddWays): HTMLButtonElement {
  const go = button(t('Add'), 'small-button primary');
  const adding = async () => {
    if (!typed.value.trim() || go.disabled) { typed.focus(); return; }
    go.disabled = true;
    said.className = 'muted small';
    try {
      const r = await servers.addByName(s, typed.value, people.map((p) => p.address), ways);
      if (r.is === 'in') { w.again(); return; }
      said.textContent = r.is === 'already' ? t('{who} is in it already', {who: named(r.address)})
        : t('Asked {who} in the Inbox. They come in once they accept you.', {who: named(r.address)});
      typed.value = '';
    } catch (e) { said.className = 'error small'; said.textContent = errorText(e); typed.focus(); }
    go.disabled = false;
  };
  go.addEventListener('click', () => void adding());
  typed.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void adding(); } });
  return go;
}

// ---- the repos, as the boards: each of one's own with the two a board has, to its people and to everyone (seen by
// everyone as the server's, never as oneself); others' shown here, as whose, its owner may take off ----

function repoCards(r: Read): (HTMLElement | null)[] {
  const own = r.mineAll.map((x) => ownRepo(r, x));
  const others = r.repos.filter((x) => !x.mine).map((x) => othersRepo(r, x));
  return [...own, ...others, own.length || others.length ? null : h('div', {class: 'empty'}, t('No repo on the Remote yet'))];
}

function ownRepo({s, w, repos, mineAll, mine}: Read, x: servers.RepoSeen): HTMLElement {
  const shares = (name: string) => mineAll.find((y) => y.name === name)?.servers.map((y) => y.id) ?? [];
  const r = repos.find((y) => y.mine && y.name === x.name);
  const c = smallCard(x.name, r?.as && r.asServer !== s.id ? line(t('Everyone sees it as {name}', {name: shownAs(r.as)})) : null);
  c.append(setting(w, c, t('Show to its people'), !!r, {what: t('The people of {server} see it as last pushed.', {server: s.name}), verb: t('Show')},
    (v) => (v ? servers.showIn(s.id, x.name) : servers.takeOff(s.id, mine!, x.name))));
  if (s.address) {
    c.append(setting(w, c, t('Show to everyone'), r?.asServer === s.id, {what: [t('Anyone sees it as {name}.', {name: shownAs(`${s.address}:${x.name}`)}), t('Your name is not shown.')], verb: t('Show')},
      (v) => (v ? servers.setSeen(x.name, 'everyone', {as: s.id}) : servers.setSeen(x.name, 'servers', {servers: [...new Set([...shares(x.name), s.id])]}))));
  }
  return c;
}

function othersRepo({s, w}: Read, r: servers.ShownRepo): HTMLElement {
  const c = smallCard(r.name, line(named(r.owner)), r.as ? line(t('Everyone sees it as {name}', {name: shownAs(r.as)})) : null);
  if (s.owner) {
    const off = button(t('Remove'), 'small-button');
    deed(off, async () => { await servers.takeOff(s.id, r.owner || r.ownerId || '', r.name); w.again(); });
    c.append(footLeft(off));
  }
  return c;
}

// ---- its boards: how far each is open and removing one, its owner's to say; taking one home, anyone's ----

/** Board `b`'s card, and where it takes guests, its guests' card after it (guests.ts). */
function boardCards(r: Read, b: servers.BoardRef): HTMLElement[] {
  if (b.gone) return [goneBoard(r, b, b.gone)];
  const c = boardCard(r, b);
  return b.guests ? [c, guestsCard(b, r.w)] : [c];
}

/** Removed: quiet, held until then, its 外す red; pressed again, it is back at once. */
function goneBoard({s, w}: Read, b: servers.BoardRef, until: number): HTMLElement {
  const back = s.owner ? h('button', {type: 'button', class: 'button small-button off', 'aria-pressed': 'true', title: t('Bring it back')}, t('Remove')) as HTMLButtonElement : null;
  if (back) deed(back, async () => { await servers.bringBackBoard(b.id); delete b.gone; w.boardsChanged(); w.again(); });
  return h('div', {class: 'card small-card off'}, h('span', {class: 'card-title'}, boardName(b.name)), line(t('Removed · back until {date}', {date: day(until)})),
    back ? h('div', {class: 'card-foot'}, back, h('span', {class: 'grow'})) : null);
}

/**
 * Narrowing board `b` (no more guests, or no longer open, `first` said before): with guests in or invitations out, it
 * ends them, and taking guests again lets none of them back by an old link, so it asks what it comes to (their posts
 * stay). With none, nothing to ask.
 */
async function endsGuests(b: servers.BoardRef, first?: string): Promise<Ask | null> {
  if (!b.guests) return null;
  const {guests, invites} = await servers.guestsOf(b.id);
  if (!guests.length && !invites.length) return null;
  return {what: [...(first ? [first] : []),
    ...(guests.length ? [tn('{n} guest no longer writes in #{board}; what they wrote stays.', '{n} guests no longer write in #{board}; what they wrote stays.', guests.length, {board: b.name})] : []),
    ...(invites.length ? [tn('{n} invitation out lets nobody in any more.', '{n} invitations out let nobody in any more.', invites.length)] : []),
    t('Taking guests again, an old link lets nobody back.')], verb: t('Turn off')};
}

function boardCard({s, w}: Read, b: servers.BoardRef): HTMLElement {
  const how = b.open ? (b.guests ? `${t('Seen by everyone')} · ${t('Guests can write')}` : t('Seen by everyone')) : t('Its people only');
  const c = smallCard(boardName(b.name), s.owner ? null : line(how));
  if (s.owner) {
    const set = (change: {open?: boolean; guests?: boolean}) => servers.setBoard(b.id, change).then((n) => { b.open = n.open; b.guests = n.guests; });
    c.append(
      setting(w, c, t('Show to everyone'), b.open, {what: t('Anyone reads #{board}, signed in or not.', {board: b.name}), verb: t('Show')}, (v) => set({open: v}),
        () => endsGuests(b, t('Only its people read #{board} then.', {board: b.name}))),
      // Guests read it as everyone does: taking them opens a board not open yet, and the ask says so first.
      setting(w, c, t('Guests can write'), b.guests, {what: [...(b.open ? [] : [t('Anyone reads #{board}, signed in or not.', {board: b.name})]),
        t('Someone its people invite writes in #{board}, shown as a guest.', {board: b.name}), t('Nobody is sent anything: you pass the invitation on yourself.')],
      verb: t('Take guests')}, (v) => set({guests: v}), () => endsGuests(b)));
  }
  const out = s.owner ? button(t('Remove'), 'small-button') : null;
  out?.addEventListener('click', () => askIn(c, out, boardName(b.name), [t('#{board} goes with its talk and TODO.', {board: b.name}), t('You can bring it back within 30 days.')], t('Remove'), async () => {
    const r = await servers.removeBoard(b.id);
    b.gone = r.until;
    w.boardsChanged();
    w.again();
  }));
  c.append(h('div', {class: 'card-foot'}, out, h('span', {class: 'grow'}), takeHome(s, b)));
  return c;
}

/** Everything stays on the Remote: Take home takes a copy of the board as text. */
function takeHome(s: servers.Server, b: servers.BoardRef): HTMLButtonElement {
  const take = button(t('Take home'), 'small-button');
  take.title = t('Everything stays on the Remote. Take a copy as text when you want one here.');
  deed(take, async () => {
    const text = await servers.archive(b.id, true);
    const a = h('a', {href: URL.createObjectURL(new Blob([text], {type: 'text/markdown'})), download: `${s.name}-${b.name}.md`.replace(/[^\w.-]+/g, '-')}) as HTMLAnchorElement;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  });
  return take;
}

// ---- the server itself: its name's term (renewed by its owner near its end), leaving it, and, its owner, removing it ----

const YEAR = 365 * 86_400_000;

function serverCards({s, w, people, mine}: Read): (HTMLElement | null)[] {
  const name = smallCard(named(s.address), line(`${t('Its code')} ${s.code}`),
    s.until ? line(s.until <= Date.now() ? t('Its term ended; held for it until {date}', {date: day(s.until + 30 * 86_400_000)}) : t('Until {date}', {date: day(s.until)})) : null);
  if (s.owner && s.until && s.until - Date.now() < YEAR) {
    const renew = button(t('Renew'), 'small-button primary');
    deed(renew, async () => { const r = await servers.renewServer(s.id); s.until = r.until; w.again(); });
    name.append(foot(renew));
  }
  // What leaving and removing come to, as the Remote does them: who is left in it, and who made it.
  const end = servers.ending(s, people, mine);
  const back = (ms: number) => tn('You can bring it back within {n} day.', 'You can bring it back within {n} days.', Math.round(ms / 86_400_000));
  const leaves = end.last ? [t('Nobody else is in it: it goes with you.'), back(end.leave)]
    : end.heir ? [t('{who} becomes its owner.', {who: named(end.heir)})] : [];
  const leaving = mine ? endCard(t('Leave this server'), leaves.map(line), t('Leave'), [t('You leave {server}.', {server: s.name}), ...leaves],
    async () => { await servers.removePerson(s.id, mine); w.gone(s.id); }) : null;
  const removing = s.owner ? endCard(t('Remove this server'), [line(back(end.remove))], t('Delete'), [t('{server} goes, with its boards.', {server: s.name}), back(end.remove)],
    async () => { await servers.removeServer(s.id); w.gone(s.id); }) : null;
  return [name, leaving, removing];
}

/** A card for leaving or removing it: what it comes to, and its deed (`verb`) at its foot, asked in the card first. */
function endCard(title: string, lines: (HTMLElement | null)[], verb: string, what: string[], act: () => Promise<void>): HTMLElement {
  const c = smallCard(title, ...lines);
  const go = button(verb, 'small-button');
  go.addEventListener('click', () => askIn(c, go, title, what, verb, act));
  c.append(foot(go));
  return c;
}
