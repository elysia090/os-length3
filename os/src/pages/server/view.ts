import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {connection} from '../../remote/connection.ts';
import type {Me} from '../../remote/inbox.ts';
import * as servers from '../../remote/servers.ts';
import {boardNew, onNews} from '../../remote/news.ts';
import {arrive, panAcross, paced, pop, stage} from '../../ui/glide.ts';
import {errorText} from '../../app/errors.ts';
import type {Context} from '../context.ts';
import {goToPlan} from '../remote/plan.ts';
import {signInBox, signInLead, signInPlace} from '../remote/sign-in.ts';
import {unreachedError, unreachedPlace} from '../remote/unreached.ts';
import {Band} from './band.ts';
import {boardBox, markBoard, newBoard} from './board.ts';
import {dockFor} from './dock.ts';
import {gear as gearSheet} from './gear.ts';
import {nameServer} from './new-server.ts';
import {current, remember, remembered, type Here, type Shown} from './parts.ts';
import {seeRepo as repoSheet} from './repo.ts';
import {Row} from './row.ts';
import {Side} from './side.ts';
import {cameTo, seenNow} from './talk.ts';

// What is in Server while it is out (layer.ts brings it out and puts it away): the band of servers on the top line
// (band.ts), under it the boards of the one chosen as a row of boxes (row.ts, board.ts), or a step away in their
// place what is behind its gear (gear.ts) or a repo shown (repo.ts), the box at the foot for the board on screen
// (dock.ts), and at the right its people and repos (side.ts). This keeps what is chosen and on screen, and tells
// each part when to draw.


/** What the view needs of the layer it is in. */
interface ViewWays {
  ctx: Context;
  /** Brought out by a press, to stay: what is written in takes the keyboard. */
  pinned(): boolean;
  /** Put the layer away at once: a way out of it taken. */
  close(): void;
  /** Built again, for who is here now (the Remote answered, or one signed in). */
  again(): void;
  /** Words in the box at the foot: a press outside leaves the layer out. */
  holding(words: () => boolean): void;
}

/** In the boards' place: the boards, or a step away from them, behind the gear or a repo shown. */
type Showing = 'boards' | 'settings' | 'repo';

export class ServerView {
  readonly work: HTMLElement;
  private readonly ways: ViewWays;
  private readonly here: Here;
  /** Where one was when Server was last out: its server and board. */
  private readonly at = remembered();
  private readonly band: Band;
  private readonly row: Row;
  /** Behind the gear, or a repo shown: in the boards' place, a step away from them. */
  private readonly sheet = h('div', {class: 'server-sheet', hidden: ''});
  private readonly dock = h('div', {class: 'dock'});
  private readonly side: Side;
  private showing: Showing = 'boards';
  /** A board went or came back behind the gear: the boards are built again on the way back to them. */
  private boardsChanged = false;
  /**
   * What is being written, by where it is written: a board's TODO, a name, the box at the foot. One no longer on
   * screen (the board moved away from) is let go, so moving along the boards holds no old box or talk.
   */
  private readonly writers = new Map<Element | 'dock', () => boolean>();
  /** Who one is, to mark oneself among the people; not known (away), no one is marked, and nothing else changes. */
  private readonly myself: Promise<Me | null>;

  constructor(ways: ViewWays) {
    this.ways = ways;
    const signedIn = connection() !== null;
    this.here = {signedIn, list: [], shown: [], serverId: null, alone: null, naming: null};
    this.band = new Band(this.here, {
      show: (id) => this.switchTo(id),
      showAlone: (b) => this.showAlone(b),
      make: () => this.makeAnew(),
      gear: () => { if (this.showing === 'settings') this.place('boards'); else this.settings(); },
    });
    const center = h('div', {class: 'center server-center'});
    this.row = new Row(center, {box: (j, now) => this.box(j, now), landed: (k, pressed) => this.landed(k, pressed)});
    this.side = new Side({isMe: (a) => this.isMe(a), seeRepo: (r) => this.seeRepo(r), write: (a) => this.write(a)});
    center.append(this.band.element, this.row.element, this.sheet, this.dock);
    this.work = h('div', {class: 'work no-strip'}, center, this.side.element, h('div', {class: 'server-bar'}, this.band.gear));
    // Signed out, whose a board is is not told: there is no right pane, and so no line where it would start.
    if (!signedIn) { this.side.element.hidden = true; this.work.classList.add('no-side'); }
    this.myself = signedIn ? import('../../remote/inbox.ts').then((inbox) => inbox.me()).catch(() => null) : Promise.resolve(null);
    this.hear();
    const held = servers.heldInvite();
    void (signedIn ? this.readServers(held) : this.readOpen(held)).finally(() => { this.listed = true; });
  }

  /** What is here is read: one's servers, or the boards open to everyone (or what is said instead). */
  private listed = false;

  /**
   * What Server opens on is drawn (layer.ts waits for it, a moment at most, to come out whole): what is here read, the
   * board on screen's talk and TODO read, and its people.
   */
  settled(): boolean {
    if (!this.listed || !this.side.painted) return false;
    const on = this.row.track.querySelector('.slide[aria-current="true"]');
    return !on?.querySelector('.board-talk:not(.board-faint) > .timeline:not([data-read]), .board-todo:empty');
  }

  /** Something being written here (a post, a TODO, a name): the layer stays out while there is. */
  writing(): boolean {
    for (const [k, f] of this.writers) if (k === 'dock' || k.isConnected) { if (f()) return true; }
    return false;
  }

  /**
   * Escape from behind the gear, or from a repo shown: back to the boards (true); from a server being named, come to
   * from one, back to that one, its box at the foot taking the keyboard as when its chip is pressed (what was written
   * in the name is kept, as it is anyway); or nothing to go back from, and Server is put away.
   */
  back(): boolean {
    const from = this.before;
    if (this.showing === 'boards' && this.here.naming?.isConnected && from && this.here.list.some((s) => s.id === from)) {
      this.show(from);
      return true;
    }
    if (this.showing === 'boards') return false;
    this.leaveSheet();
    return true;
  }

  /** The server on screen when + was pressed: Escape while one is named goes back to it. */
  private before: string | null = null;

  private readonly writer = (at: Element | 'dock', busy: () => boolean) => {
    for (const k of this.writers.keys()) if (k !== 'dock' && !k.isConnected) this.writers.delete(k);
    this.writers.set(at, busy);
  };

  private async isMe(address: string) {
    return !!(await this.myself)?.addresses.some((a) => a.address === address);
  }

  // ---- first: what there is ----

  /** Signed in: one's servers, at the one last seen; opened by an invitation's link, its board. */
  private async readServers(held: {board: string} | null) {
    // Given this session already (Home names them as it opens), the servers are drawn from that list at once, so only
    // what the board on screen holds is read before Server comes out; the list is read again under it, and what
    // changed meanwhile is taken in.
    const known = held ? null : servers.lastServers();
    if (known?.length) { this.here.list = known; this.band.paint(); this.opening(); this.listed = true; }
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
    } catch (e) { if (!known?.length) this.failed(e, t('Your servers are here again once it answers')); }
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
    if (first) this.show(first.id); else this.makeServer();
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

  /** Signed out: the boards open to everyone, and an invitation's board among them, on screen. */
  private async readOpen(held: {board: string} | null) {
    this.band.paint();
    this.side.paint(this.here.serverId);
    try {
      const got = await servers.openBoards();
      this.here.shown = got.map((b) => ({id: b.id, name: b.name, member: false, guests: b.guests, server: b.server}));
      if (held && !this.here.shown.some((b) => b.id === held.board && b.guests)) {
        const b = await this.invited(held);
        if (!b) return;
        this.here.shown = [b, ...this.here.shown.filter((x) => x.id !== b.id)];
      }
      // Nothing open to everyone: the sign-in card in the middle, as on every page that needs it; signed in,
      // Server is drawn again as the person's own.
      if (!this.here.shown.length) {
        this.row.instead(signInPlace(t('Sign in'), ...signInLead(t('Signed in, you make servers: boards for the people in them, and the repos you show them.')), signInBox(() => this.ways.again())));
        this.band.element.hidden = true;
        this.paintDock(null);
        return;
      }
      const i = this.here.shown.findIndex((b) => b.id === (held?.board ?? this.at.board));
      this.row.fill(this.here.shown.length, i >= 0 ? i : 0);
    } catch (e) { this.failed(e, t('Boards open to everyone are here again once it answers')); }
  }

  /**
   * Not read: the Remote out of reach is said in the middle, where the boards would be (the card signing in is,
   * in the same place), and Server is drawn again once it answers; anything else said, plainly.
   */
  private failed(e: unknown, what: string) {
    if (!unreachedError(e)) { this.row.track.replaceChildren(h('p', {class: 'error'}, errorText(e))); return; }
    this.row.instead(unreachedPlace(what, () => this.ways.again()));
    this.band.element.hidden = true;
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
    this.row.say(h('div', {class: 'slide', 'aria-current': 'true'}, h('div', {class: 'board-card board-said'},
      h('div', {class: 'board-body'}, h('p', {}, t('This invitation opens no board that takes guests. Ask whoever gave it to you for another.'))))));
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
    this.band.paint();
    this.here.shown = s.boards.filter((b) => !b.gone).map((b) => ({id: b.id, name: b.name, member: true, guests: b.guests, server: s.name}));
    const want = board ?? (this.at.server === id ? this.at.board : undefined);
    const i = this.here.shown.findIndex((b) => b.id === want);
    // Its boards, and after them the last box, a new board.
    this.row.fill(this.here.shown.length + 1, i >= 0 ? i : 0);
    this.side.paint(this.here.serverId);
  }

  /**
   * A server's chip pressed: its boards come in from the chip's side as the row pans along the band, as Git's repos
   * do along its band (what was there going off the other way), not swapped in one frame. From behind the gear, a
   * board alone or a server being named, it is simply shown.
   */
  private switchTo(id: string) {
    const was = this.here.list.findIndex((s) => s.id === this.here.serverId), to = this.here.list.findIndex((s) => s.id === id);
    if (this.showing !== 'boards' || was < 0 || to < 0 || was === to) { this.show(id); return; }
    panAcross(this.row.element, Math.sign(to - was), () => this.show(id));
  }

  /** A board outside the servers one is in, shown alone: no server is chosen, so the gear and the side rest. */
  private showAlone(b: Shown) {
    this.here.serverId = null;
    this.here.alone = b.id;
    this.place('boards');
    this.band.paint();
    this.here.shown = [b];
    this.row.fill(1, 0);
    this.side.paint(this.here.serverId);
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
    this.place('boards');
    const making = nameServer(this.here, {
      writer: this.writer,
      naming: (chip, ask) => { this.here.naming = chip; this.band.asking(ask); this.band.paint(); },
      made: (s) => this.made(s),
      broughtBack: async (id) => { this.here.list = await servers.servers(); this.show(id); },
      plan: () => { this.ways.close(); goToPlan(this.ways.ctx); },
      inbox: () => { this.ways.close(); this.ways.ctx.go('inbox'); },
    });
    this.row.stand(...making.slides);
    this.ways.holding(() => false);
    this.dock.replaceChildren(making.dock);
    // At the right, its first person: oneself, as its owner.
    this.side.clear();
    void this.myself.then((me) => {
      if (!this.here.naming?.isConnected || !me?.addresses[0]) return;
      this.side.ghost(me.addresses[0].address);
    });
    if (this.ways.pinned()) making.name.focus();
  }

  /** Made: the faint shapes stand whole where they were, its chip taking it in with a pop. */
  private made(s: servers.Server) {
    this.here.list.push(s);
    this.show(s.id);
    const chip = this.band.chip(s.id);
    if (chip) pop(chip, .12, 340);
    this.row.track.querySelector('.slide[aria-current="true"] .board-card')?.animate([{opacity: .35}, {opacity: 1}], {duration: paced(360), easing: 'ease-out'});
  }

  /** After leaving or removing the server on screen: the next one, or making one. */
  private gone(id: string) {
    this.here.list = this.here.list.filter((s) => s.id !== id);
    if (this.here.list[0]) this.show(this.here.list[0].id); else this.makeAnew();
  }

  // ---- the row's boxes, and the box at the foot ----

  /** What box `j` of the row holds: a board, or after them the last box, a new board. */
  private box(j: number, now: boolean): HTMLElement {
    const b = this.here.shown[j];
    return b ? boardBox(b, now, this.here.signedIn, this.writer) : newBoard(now, this.here, {writer: this.writer, made: (id, board) => this.boardMade(id, board)});
  }

  /** A board made in the last box: it stands where the box was, whole, as a server made does. */
  private boardMade(id: string, board: string) {
    this.show(id, board);
    this.row.track.querySelector('.slide[aria-current="true"] .board-card')?.animate([{opacity: .35}, {opacity: 1}], {duration: paced(360), easing: 'ease-out'});
  }

  /**
   * Box `k` on screen: remembered, and the box at the foot writes in it. The last box come to by a press (`pressed`),
   * its name takes the keyboard, as a server's does: the board is made by writing it. Come to by ← →, the keyboard
   * stays on the row, to go on along it.
   */
  private landed(k: number, pressed: boolean) {
    const b = this.here.shown[k];
    if (b) remember({server: this.here.serverId ?? undefined, board: b.id});
    this.paintDock(b ?? null);
    if (!b && pressed) this.row.track.querySelector<HTMLInputElement>('.slide[aria-current="true"] .board-name-in')?.focus({preventScroll: true});
    // Read ahead and now on screen, what its talk shows is seen.
    seenNow();
  }

  /** The box at the foot: writing in the board on screen (dock.ts). */
  private paintDock(b: Shown | null) {
    // What the box held for another board is that board's: this one says for itself.
    this.ways.holding(() => false);
    this.dock.replaceChildren(...dockFor(b, {
      signedIn: this.here.signedIn,
      pinned: () => this.ways.pinned(),
      writing: (busy) => this.writer('dock', busy),
      holding: (words) => this.ways.holding(words),
      signIn: () => { this.ways.close(); this.ways.ctx.go('remote'); },
      guestChanged: () => this.band.paint(),
    }));
  }

  /** What came in, not seen yet: a dot on its server's chip and its board's #. */
  private hear() {
    const unhear = onNews(() => {
      // Put away (or built again), this one hears no more.
      if (!this.work.isConnected) { unhear(); return; }
      this.band.mark();
      for (const head of this.row.track.querySelectorAll<HTMLElement>('.board-head[data-board]')) markBoard(head, this.here.signedIn);
      // The board on screen: what came is read in now, and is seen if its foot is in view.
      const on = this.here.shown[this.row.k];
      if (this.showing === 'boards' && on?.member && boardNew(on.id)) cameTo(on.id);
    });
  }

  // ---- a step away from the boards: behind the gear, or a repo shown ----

  private place(now: Showing) {
    // Going behind the gear (or to a repo shown), the sheet comes in from a step away; back, the boards come in, and
    // the box at the foot with them (not there a moment before the board it writes in).
    if (now !== this.showing) {
      arrive(now === 'boards' ? this.row.element : this.sheet, now === 'boards' ? -1 : 1, 'x', 16, 260);
      if (now === 'boards') arrive(this.dock, -1, 'x', 16, 260);
    }
    this.showing = now;
    this.row.element.hidden = now !== 'boards';
    this.dock.hidden = now !== 'boards';
    this.sheet.hidden = now === 'boards';
    if (now === 'boards') this.sheet.replaceChildren();
    if (now !== 'repo') this.side.seen(null);
    this.band.gear.setAttribute('aria-expanded', String(now === 'settings'));
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
    if (had && fromGear) this.band.gear.focus({preventScroll: true});
  }

  /** Behind the gear: what changes the server for everyone (gear.ts). */
  private settings() {
    const s = current(this.here);
    if (!s) return;
    const coming = this.showing !== 'settings';
    this.place('settings');
    // Come to (not drawn again after a deed there): its cards come in one after another as they are read, as a page's
    // do, not all at once a moment after its head.
    if (coming) stage(this.sheet, 1);
    void gearSheet(s, {
      sheet: this.sheet,
      still: () => this.showing === 'settings' && current(this.here) === s,
      done: () => this.leaveSheet(),
      again: () => { if (this.showing === 'settings') this.settings(); this.side.paint(this.here.serverId); },
      boardsChanged: () => { this.boardsChanged = true; },
      gone: (id) => this.gone(id),
      isMe: (address) => this.isMe(address),
      known: () => this.side.known(s.id),
    });
  }

  /** A repo shown: seen as it was last pushed, in the boards' place (repo.ts). */
  private seeRepo(r: servers.ShownRepo) {
    this.place('repo');
    this.side.seen(r);
    void repoSheet(this.sheet, r, {back: () => this.toBoards(), forge: () => { this.ways.close(); this.ways.ctx.openRepo(r.name); }});
  }

  /** Someone else pressed: a conversation with them, in the Inbox. */
  private write(address: string) {
    void import('../inbox.ts').then((m) => { m.openNext(address); this.ways.close(); this.ways.ctx.go('inbox'); });
  }
}
