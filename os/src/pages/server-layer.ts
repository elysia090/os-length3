import {day, h} from '../dom.ts';
import {mark} from '../icons.ts';
import {t} from '../i18n.ts';
import {shown as named, shownAs} from '../inbox.ts';
import {connection, onConnection, RemoteError} from '../remote.ts';
import * as servers from '../servers.ts';
import type {Context} from './context.ts';
import {cameTo, timeline} from './talk.ts';
import {dockFor} from './server-dock.ts';
import {boardTodo} from './server-todo.ts';
import {gear as gearSheet} from './server-gear.ts';
import {seeRepo as repoSheet} from './server-repo.ts';
import {button, initials, type Shown} from './server-parts.ts';
import {answers, deed} from './common.ts';
import {goToPlan, planRefused, planSaid} from './remote.ts';
import {plan as readPlan} from '../plan.ts';
import {boardNew, onNews, sawBoard, serverNew} from '../news.ts';
import {errorText} from '../errors.ts';

// Server is an operation, as File is: laid over whatever page is showing,
// never a page of its own. It is the one thing whose subject is people, not
// a repo: a server is a group of people who know each other, and each of
// its boards is a conversation and a TODO they keep together.
//
// It has the bench's shape. The servers one is in run as chips on the top
// line (+ makes one), and at its right end the server's gear. Under them its
// boards are boxes side by side, as the issues are: the board on screen in
// full, its neighbours' edges showing, an edge (or ← →) the way to them, and
// the last box a new board. A board's TODO, the same list as Home's, is
// pinned at the top of its box, written there by its people; its talk runs
// under it, and the box at the foot writes in it. On the right, where a repo's reference would be:
// who is in the server, then the repos they show in it (pressing one shows
// it as it was last pushed; a repo shown is only seen there, never written).
//
// What changes the server for everyone, who is in it, how far a board is
// open, what is shown and as whose, leaving it, is a step away, behind the
// gear; and what reaches past its people asks before it does.
//
// Resting the pointer on its icon brings it out, and it stays for LINGER
// after the pointer leaves; a press brings it out to stay. A press outside
// it, Escape, or a second press puts it away (Escape from behind the gear
// goes back to the boards first). While something is being written it stays,
// and a press outside does not put it away while the box at the foot holds
// words (they are kept with their board either way).
//
// What came in and was not seen yet is marked as the rail marks it: a dot on
// a server's chip and on a board's #, gone once its talk's foot is in view.

const OPEN_DELAY = 300;
const LINGER = 8000;
const AT = 'length3.server.at';

function remembered(): {server?: string; board?: string} {
  try { return JSON.parse(localStorage.getItem(AT) ?? '{}') as {server?: string; board?: string}; } catch { return {}; }
}
function remember(at: {server?: string; board?: string}) {
  try { localStorage.setItem(AT, JSON.stringify(at)); } catch { /* a convenience */ }
}

export class ServerLayer {
  readonly element: HTMLElement;
  private ctx: Context;
  private trigger: HTMLElement | null = null;
  private timer = 0;
  private pinned = false;
  /** Something being written here (a post, a TODO, a name): it stays out while there is. */
  private writing = (): boolean => false;
  /** Words in the box at the foot: a press outside leaves the layer out. */
  private holding = (): boolean => false;
  /** Escape from behind the gear, or from a repo shown: back to the boards (true), or nothing to go back from. */
  private back = (): boolean => false;

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.element = h('section', {class: 'server-layer', id: 'server-layer', role: 'dialog', 'aria-label': 'Server'});
    this.element.addEventListener('pointerenter', () => clearTimeout(this.timer));
    this.element.addEventListener('pointerleave', () => this.leave());
    document.addEventListener('pointerdown', (event) => {
      const at = event.target as Node;
      if (!this.isOpen || this.trigger?.contains(at) || this.element.contains(at) || this.holding()) return;
      this.close();
    });
    // Signed in or out (or the session ended elsewhere): what is out is built again for who is here now.
    onConnection(() => { if (this.isOpen) this.element.replaceChildren(this.build()); });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.isOpen) return;
      if (this.back()) return;
      this.close();
      this.trigger?.focus();
    });
  }

  get isOpen() { return this.element.isConnected; }

  /** The rail's Server button. */
  attach(button: HTMLElement) {
    this.trigger = button;
    button.setAttribute('aria-controls', 'server-layer');
    button.setAttribute('aria-expanded', 'false');
    button.addEventListener('pointerenter', () => this.later(true, this.isOpen ? 0 : OPEN_DELAY));
    button.addEventListener('pointerleave', () => this.leave());
    button.addEventListener('click', () => {
      if (this.isOpen && this.pinned) { this.close(); return; }
      this.open(true);
    });
  }

  private leave() { if (!this.pinned) this.later(false, LINGER); }

  private later(open: boolean, after: number) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => (open ? this.open(false) : (this.writing() ? undefined : this.close())), after);
  }

  /** Bring it out; `stay`: by a press, so it stays until put away. */
  open(stay: boolean) {
    clearTimeout(this.timer);
    if (stay) this.pinned = true;
    // Brought out to stay, it covers the page: the keyboard goes from the rail into it, not to the page behind it.
    if (stay) document.getElementById('page')?.setAttribute('inert', '');
    if (this.isOpen) return;
    this.element.replaceChildren(this.build());
    document.body.append(this.element);
    this.trigger?.setAttribute('aria-expanded', 'true');
  }

  close() {
    clearTimeout(this.timer);
    this.pinned = false;
    document.getElementById('page')?.removeAttribute('inert');
    this.writing = () => false;
    this.holding = () => false;
    this.back = () => false;
    this.element.replaceChildren();
    this.element.remove();
    this.trigger?.setAttribute('aria-expanded', 'false');
  }

  private build(): HTMLElement {
    const signedIn = connection() !== null;
    const chips = h('div', {class: 'chips server-chips', role: 'radiogroup', 'aria-label': 'Server'});
    const gear = h('button', {type: 'button', class: 'server-gear unseen', 'aria-label': t('Its people, boards and repos'), title: t('Its people, boards and repos'), 'aria-expanded': 'false', disabled: ''}, mark('gear')) as HTMLButtonElement;
    // + makes a server: first, at the band's left end, before the servers, which come and go to its right and so
    // never move it. The gear changes the one chosen, at the right end; with none chosen it keeps its place, unpressable.
    const plus = h('button', {type: 'button', class: 'band-add', 'aria-label': t('Make a server'), title: t('Make a server'), hidden: ''}, mark('plus')) as HTMLButtonElement;
    plus.addEventListener('click', () => { serverId = null; paintTop(); makeServer(); });
    const top = h('div', {class: 'server-top'}, plus, chips, gear);
    const track = h('div', {class: 'slide-track'});
    const prev = h('button', {type: 'button', class: 'stage-hit prev', 'aria-label': t('Previous board')}) as HTMLButtonElement;
    const next = h('button', {type: 'button', class: 'stage-hit next', 'aria-label': t('Next board')}) as HTMLButtonElement;
    const stage = h('div', {class: 'slide-stage', tabindex: '0', 'aria-label': t('Boards'), 'aria-roledescription': 'carousel'}, track, prev, next);
    const slides = h('div', {class: 'slides'}, stage);
    /** Behind the gear, or a repo shown: in the boards' place, a step away from them. */
    const sheet = h('div', {class: 'server-sheet', hidden: ''});
    const dock = h('div', {class: 'dock'});
    const side = h('aside', {class: 'side server-side', 'aria-label': t('Who is in it, and the repos they show')});
    const center = h('div', {class: 'center server-center'}, top, slides, sheet, dock);
    const work = h('div', {class: 'work no-strip'}, center, side);

    let list: servers.Server[] = [];
    let shown: Shown[] = [];
    let serverId: string | null = null;
    /** A board shown alone, outside the servers one is in: one written in as a guest, or invited to. */
    let alone: string | null = null;
    let k = 0;
    const at = remembered();
    // What is being written, by where it is written: a board's TODO, a name, the box at the foot. One no longer on
    // screen (the board moved away from) is let go, so moving along the boards holds no old box or talk.
    const writers = new Map<Element | 'dock', () => boolean>();
    const writer = (at: Element | 'dock', busy: () => boolean) => {
      for (const k of writers.keys()) if (k !== 'dock' && !k.isConnected) writers.delete(k);
      writers.set(at, busy);
    };
    this.writing = () => { for (const [k, f] of writers) if (k === 'dock' || k.isConnected) { if (f()) return true; } return false; };
    // Who one is, to mark oneself among the people; not known (away), no one is marked, and nothing else changes.
    const myself = signedIn ? import('../inbox.ts').then((inbox) => inbox.me()).catch(() => null) : Promise.resolve(null);
    const isMe = async (address: string) => !!(await myself)?.addresses.some((a) => a.address === address);
    const current = () => list.find((s) => s.id === serverId) ?? null;

    // ---- the boards' place: the boxes, or behind the gear, or a repo shown ----
    let showing: 'boards' | 'settings' | 'repo' = 'boards';
    const place = (now: typeof showing) => {
      showing = now;
      slides.hidden = now !== 'boards';
      dock.hidden = now !== 'boards';
      sheet.hidden = now === 'boards';
      if (now === 'boards') sheet.replaceChildren();
      gear.setAttribute('aria-expanded', String(now === 'settings'));
    };
    /** Back to the boards from behind the gear or a repo shown: built again if a board went meanwhile. */
    let boardsChanged = false;
    const toBoards = () => {
      if (boardsChanged && serverId) { boardsChanged = false; show(serverId); } else place('boards');
    };
    this.back = () => { if (showing === 'boards') return false; toBoards(); return true; };
    gear.addEventListener('click', () => { if (showing === 'settings') place('boards'); else settings(); });

    // ---- the boxes, slid as the issues are ----
    const go = (n: number) => {
      const count = track.children.length;
      if (!count) return;
      k = Math.max(0, Math.min(count - 1, n));
      track.style.setProperty('--at', `${k}`);
      slides.style.setProperty('--lead', `${count === 1 ? 0 : k === 0 ? 0 : k === count - 1 ? 2 : 1}`);
      slides.classList.toggle('single', count === 1);
      [...track.children].forEach((slot, j) => {
        slot.setAttribute('aria-current', String(j === k));
        const b = shown[j];
        slot.replaceChildren(b ? card(b, j === k) : newBoard(j === k));
      });
      prev.hidden = k === 0;
      next.hidden = k === count - 1;
      const b = shown[k];
      if (b) remember({server: serverId ?? undefined, board: b.id});
      paintDock(b ?? null);
    };
    prev.addEventListener('click', () => go(k - 1));
    next.addEventListener('click', () => go(k + 1));
    stage.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(k - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(k + 1); }
    });

    /** A board's box: in full where it is on screen (its TODO pinned at the top, its talk under it), only its name beside it. */
    const card = (b: Shown, now: boolean) => {
      const head = h('div', {class: 'board-head', 'data-board': b.id}, h('span', {class: 'muted board-mark', 'aria-hidden': 'true'}, '#'), h('h2', {}, b.name),
        signedIn ? null : h('span', {class: 'muted small'}, b.server), h('span', {class: 'sr-only'}));
      markBoard(head);
      if (!now) return h('div', {class: 'board-card'}, head);
      const todo = h('section', {class: 'board-todo', 'aria-label': 'TODO'});
      const talk = h('section', {class: 'board-talk', tabindex: '0', 'aria-label': b.name});
      // Its foot in view, what came is seen: the marks go, here and on the rail.
      talk.append(timeline(talk, b.id, b.member, b.member ? (post) => sawBoard(b.id, post) : undefined));
      void boardTodo(b, todo, (busy) => writer(todo, busy));
      const box = h('div', {class: 'board-card'}, head, todo, talk);
      // While its talk goes on below what is shown, the box is open at its foot: the posts run past the edge, so the
      // reader sees there is more to scroll to. At the talk's foot it closes. Said by what really scrolls, nothing else.
      const more = () => box.classList.toggle('more-below', talk.scrollHeight - talk.scrollTop - talk.clientHeight > 1);
      talk.addEventListener('scroll', more, {passive: true});
      const grown = new ResizeObserver(more);
      grown.observe(talk);
      for (const el of talk.children) grown.observe(el);
      return box;
    };

    /** The last box: a new board in this server. */
    const newBoard = (now: boolean) => {
      if (!now) return h('div', {class: 'board-card board-new'}, h('div', {class: 'board-head'}, h('span', {class: 'muted'}, '+'), h('h2', {class: 'muted'}, t('New board'))));
      const name = h('input', {class: 'line-in', maxlength: '64', placeholder: t('What it is about'), 'aria-label': t('New board')}) as HTMLInputElement;
      const make = button(t('Make'), 'primary');
      const error = h('p', {class: 'error', role: 'alert'});
      writer(name, () => document.activeElement === name || !!name.value.trim());
      const done = async () => {
        // Enter pressed again while it is made makes no second board.
        if (!name.value.trim() || !serverId || make.disabled) return;
        make.disabled = true;
        try {
          const b = await servers.makeBoard(serverId, name.value);
          current()?.boards.push(b);
          show(serverId, b.id);
        } catch (e) { error.textContent = errorText(e); make.disabled = false; }
      };
      make.addEventListener('click', () => void done());
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void done(); } });
      return h('div', {class: 'board-card board-new'},
        h('div', {class: 'board-head'}, h('span', {class: 'muted'}, '+'), h('h2', {}, t('New board'))),
        // Broken where the sentence is: what a board is, then what one may be about.
        h('div', {class: 'board-body'}, h('p', {class: 'muted'}, t('A board is one thing to talk about, with a TODO kept together:'), h('br'), t('a trip, a release, a reading group.')),
          h('div', {class: 'row'}, name, make), error));
    };

    // ---- what came in, not seen yet: a dot on its server's chip and its board's # ----
    const markBoard = (head: HTMLElement) => {
      const id = head.dataset.board ?? '', on = signedIn && boardNew(id);
      head.classList.toggle('news', on);
      const said = head.querySelector('.sr-only');
      if (said) said.textContent = on ? t('New posts') : '';
    };
    const markChip = (chip: HTMLElement) => {
      const on = serverNew(chip.dataset.server ?? '');
      chip.classList.toggle('news', on);
      const name = list.find((s) => s.id === chip.dataset.server)?.name ?? '';
      chip.setAttribute('aria-label', on ? t('{server}, new posts', {server: name}) : name);
    };
    const unhear = onNews(() => {
      // Put away (or built again), this one hears no more.
      if (!this.element.contains(work)) { unhear(); return; }
      for (const c of chips.querySelectorAll<HTMLElement>('.chip')) markChip(c);
      for (const head of track.querySelectorAll<HTMLElement>('.board-head[data-board]')) markBoard(head);
      // The board on screen: what came is read in now, and is seen if its foot is in view.
      const on = shown[k];
      if (showing === 'boards' && on?.member && boardNew(on.id)) cameTo(on.id);
    });

    // ---- the servers, on the top line ----
    const paintTop = () => {
      gear.disabled = !serverId;
      gear.classList.toggle('unseen', !serverId);
      plus.hidden = !signedIn;
      if (!signedIn) { chips.replaceChildren(h('span', {class: 'muted'}, t('Open boards'))); return; }
      const each = list.map((s) => {
        const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(s.id === serverId), title: `${named(s.address)} · ${s.code}`, 'data-server': s.id}, s.name);
        markChip(b);
        b.addEventListener('click', () => show(s.id));
        return b;
      });
      // The boards one writes in as a guest, after one's servers: each alone, said to be a guest's.
      const ours = new Set(list.flatMap((s) => s.boards.map((b) => b.id)));
      const guesting = servers.guestBoards().filter(({id}) => !ours.has(id)).map(({id, here}) => {
        const b = h('button', {type: 'button', class: 'chip guest-chip', role: 'radio', 'aria-checked': String(id === alone),
          title: t('#{board} of {server}, as a guest', {board: here.name, server: here.server})}, `#${here.name}`, h('span', {class: 'muted small'}, t('guest')));
        b.addEventListener('click', () => showAlone({id, name: here.name, member: false, guests: true, server: here.server}));
        return b;
      });
      chips.replaceChildren(...each, ...guesting);
    };

    /** A board outside the servers one is in, shown alone: no server is chosen, so the gear and the side rest. */
    const showAlone = (b: Shown) => {
      serverId = null;
      alone = b.id;
      place('boards');
      paintTop();
      shown = [b];
      track.replaceChildren(h('div', {class: 'slide'}));
      go(0);
      paintSide();
    };
    /** An invitation that opens no board taking guests here: said in the boards' place, and let go. */
    const noInvite = () => {
      servers.dropInvite();
      shown = [];
      track.replaceChildren(h('div', {class: 'slide', 'aria-current': 'true'}, h('div', {class: 'board-card board-new'},
        h('div', {class: 'board-body'}, h('p', {}, t('This invitation opens no board that takes guests. Ask whoever gave it to you for another.'))))));
      slides.classList.add('single');
      prev.hidden = next.hidden = true;
      paintDock(null);
    };
    /**
     * Opened by an invitation's link: its board, whatever else is here. One of its people already
     * needs no invitation, and is shown it in its server.
     */
    const invited = async (held: {board: string}): Promise<Shown | null> => {
      const s = list.find((x) => x.boards.some((b) => b.id === held.board && !b.gone));
      if (s) { servers.dropInvite(); show(s.id, held.board); return null; }
      const b = await servers.openBoard(held.board).catch(() => null);
      if (!b?.guests) { noInvite(); return null; }
      return {id: b.id, name: b.name, member: false, guests: true, server: b.server.name};
    };

    /** No server chosen (or none yet): the one box makes a server, with a name on this Remote as a person has (first come, for five years at a time). */
    const makeServer = () => {
      shown = [];
      alone = null;
      place('boards');
      const name = h('input', {class: 'line-in', maxlength: '64', placeholder: t('Trip')}) as HTMLInputElement;
      const handle = h('input', {class: 'line-in mono', maxlength: '31', placeholder: 'trip', autocapitalize: 'off', spellcheck: 'false'}) as HTMLInputElement;
      // Its address follows its name until it is written itself.
      let own = false;
      const slug = (v: string) => v.toLowerCase().normalize('NFKD').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 31);
      name.addEventListener('input', () => { if (!own) handle.value = slug(name.value); });
      handle.addEventListener('input', () => { own = handle.value !== ''; });
      const make = button(t('Make'), 'primary');
      const error = h('p', {class: 'error', role: 'alert'});
      writer(name, () => document.activeElement === name || document.activeElement === handle || !!name.value.trim());
      const done = async () => {
        // Enter pressed again while it is made makes no second server.
        if (!name.value.trim() || make.disabled) return;
        make.disabled = true;
        try {
          const s = await servers.makeServer(name.value, handle.value);
          list.push(s);
          show(s.id);
        } catch (e) {
          make.disabled = false;
          // Making a server is the plan's to allow: said here, with the way to the Plan.
          const plan = planRefused(e, () => { this.close(); goToPlan(this.ctx); });
          // Said once: the line under the form already says it, so the refusal takes its place.
          if (plan) { paid.replaceChildren(); error.replaceChildren(plan); }
          else if (e instanceof RemoteError && e.status === 409 && /address/i.test(e.message)) {
            const inbox = button(t('Go to Inbox'), 'small-button');
            inbox.addEventListener('click', () => { this.close(); this.ctx.go('inbox'); });
            error.replaceChildren(t('A server needs your name. Claim one in Inbox.'), ' ', inbox);
          } else error.textContent = errorText(e);
        }
      };
      make.addEventListener('click', () => void done());
      // Free, making one is not offered by the Remote: said before anything is written, with the way to the Plan.
      const paid = h('p', {class: 'muted small'});
      void readPlan().then((p) => {
        if (p.plan !== 'free') return;
        paid.replaceChildren(planSaid({rule: 'server', buy: !!p.buy}, () => { this.close(); goToPlan(this.ctx); }));
      }, () => {});
      for (const f of [name, handle]) f.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void done(); } });
      // What one removed or left last, still held: brought back with its name and boards.
      const back = h('div', {class: 'server-back'});
      void servers.goneServers().then((held) => back.replaceChildren(...held.map((g) => {
        const b = button(t('Bring back {name}', {name: g.name}), 'small-button');
        b.title = t('Held until {date}', {date: day(g.until)});
        deed(b, async () => { await servers.bringBack(g.id); list = await servers.servers(); show(g.id); });
        return b;
      })), (e) => back.replaceChildren(h('p', {class: 'error small'}, errorText(e))));
      track.replaceChildren(h('div', {class: 'slide', 'aria-current': 'true'}, h('div', {class: 'board-card board-new'},
        h('div', {class: 'board-head'}, h('span', {class: 'muted'}, '+'), h('h2', {}, t('Make a server'))),
        h('div', {class: 'board-body'},
          h('p', {}, t('A server is people you know: you add them from your Inbox contacts. Its boards are each a conversation and a TODO you keep together.')),
          // Fields as New repo's: a label over each, what it means under it.
          h('label', {class: 'field'}, h('span', {class: 'field-label'}, t('Name')), name),
          h('label', {class: 'field'}, h('span', {class: 'field-label'}, t('Name on this Remote')), handle,
            h('span', {class: 'muted small'}, t('First come, as a person\'s: nobody else\'s while the server has it, renewed by its owner every five years.'))),
          paid, answers(null, make), error, back))));
      slides.classList.add('single');
      track.style.setProperty('--at', '0');
      prev.hidden = next.hidden = true;
      paintDock(null);
      paintSide();
      if (this.pinned) name.focus();
    };

    /** Show server `id`, at board `board` (or the one last seen, or its first). */
    const show = (id: string, board?: string) => {
      const s = list.find((x) => x.id === id);
      if (!s) { makeServer(); return; }
      serverId = id;
      alone = null;
      place('boards');
      paintTop();
      shown = s.boards.filter((b) => !b.gone).map((b) => ({id: b.id, name: b.name, member: true, guests: b.guests, server: s.name}));
      track.replaceChildren(...[...shown, null].map(() => h('div', {class: 'slide'})));
      const want = board ?? (at.server === id ? at.board : undefined);
      const i = shown.findIndex((b) => b.id === want);
      go(i >= 0 ? i : 0);
      paintSide();
    };
    /** After leaving or removing the server on screen: the next one, or making one. */
    const gone = (id: string) => {
      list = list.filter((s) => s.id !== id);
      if (list[0]) show(list[0].id); else { serverId = null; paintTop(); makeServer(); }
    };

    // ---- the box at the foot: writing in the board on screen ----
    const paintDock = (b: Shown | null) => {
      // What the box held for another board is that board's: this one says for itself.
      this.holding = () => false;
      dock.replaceChildren(...dockFor(b, {
        signedIn,
        pinned: () => this.pinned,
        writing: (busy) => writer('dock', busy),
        holding: (words) => { this.holding = words; },
        signIn: () => { this.close(); this.ctx.go('remote'); },
        guestChanged: () => paintTop(),
      }));
    };

    // ---- the right: who is in it, then the repos they show in it ----
    const part = (title: string, ...body: (Node | null)[]) => h('section', {class: 'side-part'}, h('h3', {}, title), ...body);
    const faceOf = (address: string) => h('span', {class: 'face', 'aria-hidden': 'true'}, initials(address));
    const repoName = (r: servers.ShownRepo) => [h('span', {}, r.name), h('span', {class: 'muted small'}, named(r.owner))];
    let sideToken = 0;
    const paintSide = () => {
      const mine = ++sideToken;
      // Outside a server (an open board, or none chosen), whose it is is not told: the side stays, empty, so the
      // center keeps its width and nothing on the band moves when a server is chosen or made.
      if (!serverId) { side.replaceChildren(); return; }
      const id = serverId;
      void Promise.all([servers.people(id), servers.shownIn(id)]).then(([people, repos]) => {
        if (mine !== sideToken) return;
        side.replaceChildren(
          part(t('People'), h('ul', {class: 'people'}, ...people.map((p) => h('li', {}, faceOf(p.address), h('span', {}, named(p.address)),
            p.owner ? h('span', {class: 'muted small'}, t('owner')) : null)))),
          // The repos shown, when there are any: nothing is said of none here.
          repos.length ? part(t('Repos'), h('ul', {class: 'side-repos'}, ...repos.map((r) => {
              const b = h('button', {type: 'button', class: 'side-repo', title: r.as ? t('Everyone sees it as {name}', {name: shownAs(r.as)}) : `${named(r.owner)}:${r.name}`},
                ...repoName(r), r.as ? h('span', {class: 'seen-mark muted small'}, t('everyone')) : null);
              b.addEventListener('click', () => seeRepo(r));
              return h('li', {}, b);
            }))) : '');
      }).catch((e) => { if (mine === sideToken) side.replaceChildren(h('p', {class: 'error'}, errorText(e))); });
    };

    // ---- a repo shown: seen as it was last pushed, in the boards' place ----
    const seeRepo = (r: servers.ShownRepo) => {
      place('repo');
      void repoSheet(sheet, r, {back: toBoards, forge: () => { this.close(); this.ctx.openRepo(r.name); }});
    };

    // ---- behind the gear: what changes the server for everyone (server-gear.ts) ----
    const settings = () => {
      const s = current();
      if (!s) return;
      place('settings');
      void gearSheet(s, {
        sheet,
        still: () => showing === 'settings' && current() === s,
        done: toBoards,
        again: () => { if (showing === 'settings') settings(); paintSide(); },
        boardsChanged: () => { boardsChanged = true; },
        gone,
        isMe,
      });
    };

    // ---- first: what there is ----
    const held = servers.heldInvite();
    if (signedIn) {
      void servers.servers().then(async (got) => {
        list = got;
        paintTop();
        if (held) {
          const b = await invited(held);
          if (b) showAlone(b);
          return;
        }
        const first = list.find((s) => s.id === at.server) ?? list[0];
        if (first) show(first.id); else makeServer();
      }).catch((e) => track.replaceChildren(h('p', {class: 'error'}, errorText(e))));
    } else {
      paintTop();
      paintSide();
      void servers.openBoards().then(async (got) => {
        shown = got.map((b) => ({id: b.id, name: b.name, member: false, guests: b.guests, server: b.server}));
        // Opened by an invitation: its board is among them, and on screen.
        if (held && !shown.some((b) => b.id === held.board && b.guests)) {
          const b = await invited(held);
          if (!b) return;
          shown = [b, ...shown.filter((x) => x.id !== b.id)];
        }
        if (!shown.length) {
          track.replaceChildren(h('div', {class: 'slide', 'aria-current': 'true'}, h('div', {class: 'board-card board-new'},
            h('div', {class: 'board-body'}, h('p', {}, t('No board is open to everyone. Sign in to make a server with people you know.'))))));
          slides.classList.add('single');
          prev.hidden = next.hidden = true;
          paintDock(null);
          return;
        }
        track.replaceChildren(...shown.map(() => h('div', {class: 'slide'})));
        const i = shown.findIndex((b) => b.id === (held?.board ?? at.board));
        go(i >= 0 ? i : 0);
      }).catch((e) => track.replaceChildren(h('p', {class: 'error'}, errorText(e))));
    }

    return work;
  }
}
