import {h} from '../../ui/dom.ts';
import {t} from '../../../text/i18n.ts';
import {connection} from '../../../shipto/connection.ts';
import {me, type Me} from '../../../shipto/inbox.ts';
import * as servers from '../../../shipto/servers.ts';
import {boardNew, onNews} from '../../../shipto/news.ts';
import {openNext} from '../kit/next.ts';
import {deskSearch, placesMenu} from '../kit/places.ts';
import {errorText} from '../../../api/errors.ts';
import type {Context} from '../kit/context.ts';
import {goToPlan} from '../kit/plan-gate.ts';
import {signInBox, signInLead, signInPlace} from '../kit/sign-in.ts';
import {unreachedError, unreachedPlace} from '../kit/unreached.ts';
import {Band} from './band.ts';
import {boardBox, newBoard} from './board.ts';
import {dockFor} from './dock.ts';
import {gear as gearSheet} from './gear.ts';
import {nameServer} from './new-server.ts';
import {current, remember, remembered, type Here, type Shown} from './parts.ts';
import {seeRepo as repoSheet} from './repo.ts';
import {TopicDesk} from './topic-desk.ts';
import {TopicIndex} from './topic-index.ts';
import {cameTo, seenNow} from './talk.ts';

// The room and its topics are an index, not more papers on the desk. Only the
// topic in hand is drawn. Management and shared repos use the same measure.

/** What the view needs of the page it is on. */
interface ViewWays {
  ctx: Context;
  /** Built again, for who is here now (the Remote answered, or one signed in). */
  again(): void;
}

/** In the boards' place: the boards, or a step away from them, behind the gear or a repo shown. */
type Showing = 'boards' | 'settings' | 'repo';

export class ServerView {
  readonly work: HTMLElement;
  private readonly ways: ViewWays;
  private readonly here: Here;
  /** Where one was when Server was last on screen: its server and board (or led here to make one). */
  private readonly at = remembered();
  /** The board last held in each server while this desk is open, by its stable identity. */
  private readonly lastBoards = new Map<string, string>();
  private readonly band: Band;
  private readonly desk: TopicDesk;
  /** Behind the gear, or a repo shown: in the boards' place, a step away from them. */
  private readonly sheet = h('div', {class: 'server-sheet', hidden: ''});
  private readonly dock = h('div', {class: 'dock'});
  private readonly index = new TopicIndex();
  private readonly sidebar: HTMLElement;
  private showing: Showing = 'boards';
  /** A board went or came back behind the gear: the boards are built again on the way back to them. */
  private boardsChanged = false;
  /** Who one is, to mark oneself among the people; not known (away), no one is marked, and nothing else changes. */
  private readonly myself: Promise<Me | null>;

  constructor(ways: ViewWays) {
    this.ways = ways;
    const signedIn = connection() !== null;
    this.here = {signedIn, list: [], shown: [], serverId: null, alone: null, naming: null};
    this.band = new Band(this.here, {
      // The checked room is where we are: choosing it only puts the menu away.
      show: (id) => { if (id !== this.here.serverId) this.show(id); },
      showAlone: (b) => this.showAlone(b),
      make: () => this.makeAnew(),
      manage: () => {
        if (this.showing !== 'settings') this.settings();
        this.sheet.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({preventScroll: true});
      },
      paperEdge: () => this.desk.element.getBoundingClientRect().left,
      rename: async (id, name) => {
        const named = await servers.renameServer(id, name);
        const room = this.here.list.find((s) => s.id === id);
        if (!this.work.isConnected || !room) return;
        room.name = named.name;
        if (this.here.serverId === id) {
          for (const b of this.here.shown) b.server = named.name;
          const title = this.sheet.querySelector('.sheet-title h2');
          if (this.showing === 'settings' && title) title.textContent = named.name;
        }
        this.band.paint();
      },
    });
    const masthead = h('header', {class: 'server-masthead'}, h('h1', {}, 'Server'));
    placesMenu(masthead, ['Server'] as const, 'Server', () => {}, () => [
      {label: 'Inbox', run: () => { void ways.ctx.go('inbox'); }, onPress: true},
      ...(ways.ctx.placeCommands?.(['server']) ?? []),
    ], {find: deskSearch(ways.ctx)});
    this.sidebar = h('aside', {class: 'server-sidebar'}, this.band.element, this.index.element);
    this.desk = new TopicDesk({box: (j) => this.box(j), landed: (k, pressed) => this.landed(k, pressed)}, this.dock);
    this.desk.paper.addEventListener('topic-posts', (event) => {
      const field = this.dock.querySelector<HTMLTextAreaElement>('[data-member-reply]');
      if (field) field.placeholder = t((event as CustomEvent<boolean>).detail ? 'Write a reply' : 'Write a post');
    });
    const center = h('div', {class: 'server-center'}, this.sidebar,
      h('div', {class: 'server-focus'}, this.desk.element, this.sheet));
    this.work = h('div', {class: 'work server-work no-strip no-side'}, masthead, center);
    this.myself = signedIn ? me().catch(() => null) : Promise.resolve(null);
    this.hear();
    const held = servers.heldInvite();
    void (signedIn ? this.readServers(held) : this.readOpen(held));
  }

  /**
   * Escape from behind the gear, or from a repo shown: back to the boards (true); from a server being named, come to
   * from one, back to that one, its box at the foot taking the keyboard as when its chip is pressed (what was written
   * in the name is kept, as it is anyway); or nothing to go back from (false).
   */
  back(): boolean {
    if (this.band.close(true)) return true;
    const from = this.before;
    if (this.showing === 'boards' && this.here.naming?.isConnected && from && this.here.list.some((s) => s.id === from)) {
      this.show(from);
      this.band.key.focus({preventScroll: true});
      return true;
    }
    if (this.showing === 'boards') {
      if (!this.here.serverId || this.desk.k < this.here.shown.length || !this.here.shown.length) return false;
      const last = this.lastBoards.get(this.here.serverId);
      const at = this.here.shown.findIndex((b) => b.id === last);
      this.desk.go(at < 0 ? 0 : at);
      this.index.focusNew();
      return true;
    }
    if (this.showing === 'repo') this.settings(); else this.leaveSheet();
    return true;
  }

  /** The server on screen when + was pressed: Escape while one is named goes back to it. */
  private before: string | null = null;

  private async isMe(address: string) {
    return !!(await this.myself)?.addresses.some((a) => a.address === address);
  }

  // ---- first: what there is ----

  /** Signed in: one's servers, at the one last seen; opened by an invitation's link, its board. */
  private async readServers(held: {board: string} | null) {
    // Given this session already (Home names them as it opens), the servers are drawn from that list at once, so only
    // what the board on screen holds is read as it comes; the list is read again under it, and what
    // changed meanwhile is taken in.
    const known = held ? null : servers.lastServers();
    if (known?.length) { this.here.list = known; this.band.paint(); this.opening(); }
    try {
      const fresh = await servers.servers();
      if (known?.length) { this.tookFresh(fresh); return; }
      this.here.list = fresh;
      this.band.paint();
      if (held) {
        const b = await this.invited(held);
        if (b) this.showAlone(b);
        return;
      }
      this.opening();
    } catch (e) { if (!known?.length) this.failed(e, t('Servers will reappear once Remote responds')); }
  }

  /** What Server opens at, the servers read: the one last seen, a guest's board, or making the first. */
  private opening() {
    // Left at (or led to, from Home) a board written in as a guest: that board, alone, as its chip shows it.
    const guest = !this.at.server && this.at.board ? servers.guestBoards().find((g) => g.id === this.at.board) : undefined;
    if (guest && !this.here.list.some((s) => s.boards.some((b) => b.id === guest.id))) {
      this.showAlone({id: guest.id, name: guest.here.name, member: false, guests: true, server: guest.here.server});
      return;
    }
    const first = this.here.list.find((s) => s.id === this.at.server) ?? this.here.list[0];
    if (this.at.making) {
      // Led here to make one (the servers beside the rail): made, or not now, it is where one was.
      this.before = first?.id ?? null;
      remember({server: first?.id});
      this.makeServer();
    } else if (first) this.show(first.id); else this.makeServer();
  }

  /**
   * The list read again under one drawn from what was known: its names and dots taken in; the server on screen gone
   * (left on another device), the next; its boards changed meanwhile, drawn again; otherwise nothing moves.
   */
  private tookFresh(fresh: servers.Server[]) {
    const on = this.here.serverId;
    const was = this.here.list.find((s) => s.id === on);
    const now = fresh.find((s) => s.id === on);
    const boards = (s: servers.Server | undefined) => JSON.stringify(s?.boards.map((b) => [b.id, b.name, !!b.gone]) ?? null);
    this.here.list = fresh;
    if (on && !now) { this.gone(on); return; }
    this.band.paint();
    if (now && this.showing === 'boards' && boards(was) !== boards(now)) this.show(now.id);
  }

  /**
   * Signed out: the boards open to everyone, and an invitation's board among them, on screen. Drawn at once from those
   * this Remote last gave (servers.ts), as they are asked again: changed meanwhile, Server is drawn again from them.
   */
  private async readOpen(held: {board: string} | null) {
    this.band.paint();
    const anyones = (l: {id: string; name: string; guests: boolean; server: string}[]): Shown[] =>
      l.map((b) => ({id: b.id, name: b.name, member: false, guests: b.guests, server: b.server}));
    const known = held ? null : servers.lastOpenBoards();
    if (known) this.drawOpen(anyones(known), null);
    try {
      const got = await servers.openBoards();
      if (known) { if (JSON.stringify(got) !== JSON.stringify(known)) this.ways.again(); return; }
      let shown = anyones(got);
      if (held && !shown.some((b) => b.id === held.board && b.guests)) {
        const b = await this.invited(held);
        if (!b) return;
        shown = [b, ...shown.filter((x) => x.id !== b.id)];
      }
      this.drawOpen(shown, held);
    } catch (e) { if (!known) this.failed(e, t('Public boards will reappear once Remote responds')); }
  }

  /** The open boards on screen, at the invitation's or the one last seen. */
  private drawOpen(shown: Shown[], held: {board: string} | null) {
    this.here.shown = shown;
    // Nothing open to everyone: Server's head and the sign-in card under it, where every page that needs one has
    // them (Remote's, Inbox's: going between them, the card does not move); signed in, Server is drawn again as the
    // person's own.
    if (!shown.length) {
      this.desk.instead(h('div', {class: 'server-signed-out'},
        signInPlace(t('Sign in'), ...signInLead(t('Signing in lets you create servers to share boards and repos with members.')), signInBox(() => this.ways.again()))));
      this.sidebar.hidden = true;
      this.paintDock(null);
      return;
    }
    const i = shown.findIndex((b) => b.id === (held?.board ?? this.at.board));
    this.desk.fill(shown.length, i >= 0 ? i : 0);
  }

  /**
   * Not read: the Remote out of reach is said in the middle, where the boards would be (the card signing in is,
   * in the same place), and Server is drawn again once it answers; anything else said, plainly.
   */
  private failed(e: unknown, what: string) {
    if (!unreachedError(e)) { this.desk.instead(h('p', {class: 'error'}, errorText(e))); return; }
    this.desk.instead(unreachedPlace(what, () => this.ways.again()));
    this.sidebar.hidden = true;
    this.paintDock(null);
  }

  /**
   * Opened by an invitation's link: its board, whatever else is here. One of its people already
   * needs no invitation, and is shown it in its server.
   */
  private async invited(held: {board: string}): Promise<Shown | null> {
    const s = this.here.list.find((x) => x.boards.some((b) => b.id === held.board && !b.gone));
    if (s) { servers.dropInvite(); this.show(s.id, held.board); return null; }
    const b = await servers.openBoard(held.board).catch(() => null);
    if (!b?.guests) { this.noInvite(); return null; }
    return {id: b.id, name: b.name, member: false, guests: true, server: b.server.name};
  }

  /** An invitation that opens no board taking guests here: said in the boards' place, and let go. */
  private noInvite() {
    servers.dropInvite();
    this.here.shown = [];
    this.desk.instead(h('div', {class: 'board-body'}, t('Invalid invite link. Request a new invite from the server owner.')));
    this.paintDock(null);
  }

  // ---- what is shown: a server, a board alone, or one being made ----

  /** Show server `id`, at board `board` (or the one last seen, or its first). */
  private show(id: string, board?: string) {
    const s = this.here.list.find((x) => x.id === id);
    if (!s) { this.makeServer(); return; }
    this.here.naming = null;
    this.here.serverId = id;
    this.here.alone = null;
    this.place('boards');
    this.sidebar.hidden = false;
    this.band.paint();
    this.here.shown = s.boards.filter((b) => !b.gone).map((b) => ({id: b.id, name: b.name, member: true, guests: b.guests, server: s.name}));
    const want = board ?? this.lastBoards.get(id) ?? (this.at.server === id ? this.at.board : undefined);
    const i = this.here.shown.findIndex((b) => b.id === want);
    // Its boards, and after them the last box, a new board.
    this.desk.fill(this.here.shown.length + 1, i >= 0 ? i : 0);
  }

  /** A board outside the servers one is in, shown alone: no server is chosen, so the gear and the side rest. */
  private showAlone(b: Shown) {
    this.here.serverId = null;
    this.here.alone = b.id;
    this.place('boards');
    this.sidebar.hidden = false;
    this.band.paint();
    this.here.shown = [b];
    this.desk.fill(1, 0);
  }

  /** No server chosen: one is made, where it will stand. */
  private makeAnew() {
    this.before = this.here.serverId ?? this.before;
    this.here.serverId = null;
    this.band.paint();
    this.makeServer();
  }

  /** A server being made: its chip in the band, and the server it will be standing faint under it (new-server.ts). */
  private makeServer() {
    this.here.shown = [];
    this.here.alone = null;
    this.sidebar.hidden = false;
    this.place('boards');
    const making = nameServer(this.here, {
      naming: (chip, ask) => { this.here.naming = chip; this.band.asking(ask); this.band.paint(); },
      made: (s) => this.made(s),
      broughtBack: async (id) => { this.here.list = await servers.servers(); this.show(id); },
      plan: () => goToPlan(this.ways.ctx),
    });
    this.index.update([], 0, null, () => {});
    this.desk.stand(making.paper);
    this.dock.replaceChildren(making.dock);
    // Drawn as the page is built: the keyboard goes to it once it is on the page, which is not scrolled for it (it may
    // be rising in from under the window yet, main.ts select).
    queueMicrotask(() => making.name.focus({preventScroll: true}));
  }

  /** Made: the new room is held. */
  private made(s: servers.Server) {
    this.here.list.push(s);
    this.show(s.id);
  }

  /** After leaving or removing the server on screen: the next one, or making one. */
  private gone(id: string) {
    this.here.list = this.here.list.filter((s) => s.id !== id);
    if (this.here.list[0]) this.show(this.here.list[0].id); else this.makeAnew();
  }

  // ---- the row's boxes, and the box at the foot ----

  /** What is in hand: a topic, or the paper which names the next one. */
  private box(j: number) {
    const b = this.here.shown[j];
    return b ? boardBox(b) : {body: newBoard(this.here, {made: (id, board) => this.boardMade(id, board)})};
  }

  /** A board made in the last box: it stands where the box was, whole, as a server made does. */
  private boardMade(id: string, board: string) {
    if (!this.work.isConnected || this.here.serverId !== id || this.showing !== 'boards') return;
    this.show(id, board);
    this.index.focusCurrent();
  }

  /**
   * Box `k` on screen: remembered, and the box at the foot writes in it. The last box come to by a press (`pressed`),
   * its name takes the keyboard, as a server's does: the board is made by writing it. Come to by ← →, the keyboard
   * stays on the row, to go on along it.
   */
  private landed(k: number, pressed: boolean) {
    const b = this.here.shown[k];
    if (b) {
      if (this.here.serverId) this.lastBoards.set(this.here.serverId, b.id);
      remember({server: this.here.serverId ?? undefined, board: b.id});
    }
    this.paintDock(b ?? null);
    this.paintIndex();
    if (!b && pressed) this.desk.paper.querySelector<HTMLInputElement>('.board-name-in')?.focus({preventScroll: true});
    // A visible transcript can be marked seen.
    seenNow();
  }

  /** Keep the index in place while its unread marks and held topic change. */
  private paintIndex() {
    const show = !this.here.alone && !this.here.naming;
    this.index.update(show ? this.here.shown : [], this.desk.k, this.here.serverId, (j) => this.desk.go(j, true));
  }

  /** The box at the foot: writing in the board on screen (dock.ts). */
  private paintDock(b: Shown | null) {
    // What the box held for another board is that board's: this one says for itself.
    this.dock.replaceChildren(...dockFor(b, {
      signedIn: this.here.signedIn,
      signIn: () => this.ways.ctx.go('remote'),
      guestChanged: () => this.band.paint(),
    }));
  }

  /** What came in, not seen yet: a dot on its server's chip and its board's #. */
  private hear() {
    const unhear = onNews(() => {
      // Put away (or built again), this one hears no more.
      if (!this.work.isConnected) { unhear(); return; }
      this.band.mark();
      this.paintIndex();
      // The board on screen: what came is read in now, and is seen if its foot is in view.
      const on = this.here.shown[this.desk.k];
      if (this.showing === 'boards' && on?.member && boardNew(on.id)) cameTo(on.id);
    });
  }

  // ---- a step away from the boards: behind the gear, or a repo shown ----

  private place(now: Showing) {
    this.showing = now;
    this.desk.element.hidden = now !== 'boards';
    this.sheet.hidden = now === 'boards';
    if (now === 'boards') { this.sheet.replaceChildren(); seenNow(); }
  }

  /** Back to the boards from behind the gear or a repo shown: built again if a board went meanwhile. */
  private toBoards() {
    if (this.boardsChanged && this.here.serverId) { this.boardsChanged = false; this.show(this.here.serverId); } else this.place('boards');
  }

  /** Back to the boards with the keyboard where it went in: the gear, when it was behind the gear. */
  private leaveSheet() {
    const had = this.sheet.contains(document.activeElement);
    const fromGear = this.showing === 'settings';
    this.toBoards();
    if (had && fromGear) this.band.key.focus({preventScroll: true});
  }

  /** Behind the gear: what changes the server for everyone (gear.ts). */
  private settings() {
    const s = current(this.here);
    if (!s) return;
    this.place('settings');
    void gearSheet(s, {
      sheet: this.sheet,
      still: () => this.showing === 'settings' && current(this.here) === s,
      done: () => this.leaveSheet(),
      again: () => { if (this.showing === 'settings') this.settings(); },
      boardsChanged: () => { this.boardsChanged = true; },
      gone: (id) => this.gone(id),
      isMe: (address) => this.isMe(address),
      write: (address) => this.write(address),
      seeRepo: (r) => this.seeRepo(r),
    });
  }

  /** A repo shown: seen as it was last pushed, in the boards' place (repo.ts). */
  private seeRepo(r: servers.ShownRepo) {
    this.place('repo');
    void repoSheet(this.sheet, r, {back: () => this.settings(), forge: () => this.ways.ctx.openRepo(r.name)});
  }

  /** Someone else pressed: a conversation with them, in the Inbox. */
  private write(address: string) {
    openNext(address);
    void this.ways.ctx.go('inbox');
  }
}
