import {ago, h} from '../dom.ts';
import {mark} from '../icons.ts';
import {t} from '../i18n.ts';
import {shown as named, shownAs} from '../inbox.ts';
import {connection, RemoteError} from '../remote.ts';
import * as servers from '../servers.ts';
import {parts} from './common.ts';
import type {Context} from './context.ts';
import {postNow, timeline} from './talk.ts';
import {todoList} from './todo-box.ts';

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
// goes back to the boards first). While something is being written it stays.

const OPEN_DELAY = 300;
const LINGER = 8000;
const AT = 'length3.server.at';
/** Past this, a file shown is cut short. */
const SHOW_BYTES = 256 * 1024;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const initials = (address: string) => [...address.split('@')[0]].slice(0, 2).join('').toUpperCase();
const button = (text: string, kind = '') => h('button', {type: 'button', class: `button ${kind}`.trim()}, text) as HTMLButtonElement;
function remembered(): {server?: string; board?: string} {
  try { return JSON.parse(localStorage.getItem(AT) ?? '{}') as {server?: string; board?: string}; } catch { return {}; }
}
function remember(at: {server?: string; board?: string}) {
  try { localStorage.setItem(AT, JSON.stringify(at)); } catch { /* a convenience */ }
}

/**
 * Asked in the card, as Remote asks before a repo is turned off: the card
 * gives way to what will happen and the two answers, Not now at the left and
 * the deed at the right, and comes back as it was if the answer is no.
 */
function askIn(card: HTMLElement, title: string, what: string | string[], verb: string, act: () => Promise<void>) {
  const was = [...card.childNodes];
  const error = h('p', {class: 'error small', role: 'alert'});
  const no = button(t('Not now'), 'small-button'), yes = button(verb, 'small-button primary');
  no.addEventListener('click', () => card.replaceChildren(...was));
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    try { await act(); } catch (e) { error.textContent = message(e); yes.disabled = false; }
  });
  // What will happen, a short line each: a line breaks where the sentence does, not where the card ends.
  card.replaceChildren(h('div', {class: 'off-ask'}, h('span', {class: 'card-title'}, title), ...[what].flat().map((l) => h('p', {class: 'muted small'}, l)), error,
    h('div', {class: 'card-foot'}, no, h('span', {class: 'grow'}), yes)));
  yes.focus();
}

/** A small card, as Runtime's and Remote's: its title, a line or two, then what can be done at its foot. */
const smallCard = (title: string, ...rest: (Node | null)[]) => h('div', {class: 'card small-card'}, h('span', {class: 'card-title'}, title), ...rest);
const line = (text: string) => (text ? h('span', {class: 'muted small'}, text) : null);
const foot = (...xs: (Node | null)[]) => h('div', {class: 'card-foot'}, h('span', {class: 'grow'}), ...xs);

/** A board as the layer holds it: whose it is to write in. */
interface Shown { id: string; name: string; member: boolean; guests: boolean; server: string }

export class ServerLayer {
  readonly element: HTMLElement;
  private ctx: Context;
  private trigger: HTMLElement | null = null;
  private timer = 0;
  private pinned = false;
  /** Something being written here (a post, a TODO, a name): it stays out while there is. */
  private writing = (): boolean => false;
  /** Escape from behind the gear, or from a repo shown: back to the boards (true), or nothing to go back from. */
  private back = (): boolean => false;

  constructor(ctx: Context) {
    this.ctx = ctx;
    this.element = h('div', {class: 'server-layer', id: 'server-layer', role: 'dialog', 'aria-label': 'Server'});
    this.element.addEventListener('pointerenter', () => clearTimeout(this.timer));
    this.element.addEventListener('pointerleave', () => this.leave());
    document.addEventListener('pointerdown', (event) => {
      const at = event.target as Node;
      if (!this.isOpen || this.trigger?.contains(at) || this.element.contains(at)) return;
      this.close();
    });
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
    if (this.isOpen) return;
    this.element.replaceChildren(this.build());
    document.body.append(this.element);
    this.trigger?.setAttribute('aria-expanded', 'true');
  }

  close() {
    clearTimeout(this.timer);
    this.pinned = false;
    this.writing = () => false;
    this.back = () => false;
    this.element.replaceChildren();
    this.element.remove();
    this.trigger?.setAttribute('aria-expanded', 'false');
  }

  private build(): HTMLElement {
    const signedIn = connection() !== null;
    const chips = h('div', {class: 'chips server-chips', role: 'radiogroup', 'aria-label': 'Server'});
    const gear = h('button', {type: 'button', class: 'server-gear', 'aria-label': t('Its people, boards and repos'), title: t('Its people, boards and repos'), 'aria-expanded': 'false', hidden: ''}, mark('gear')) as HTMLButtonElement;
    const top = h('div', {class: 'server-top'}, chips, gear);
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
    let k = 0;
    const at = remembered();
    const writers: (() => boolean)[] = [];
    this.writing = () => writers.some((f) => f());
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
    gear.addEventListener('click', () => { if (showing === 'settings') place('boards'); else void settings(); });

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
      const head = h('header', {class: 'board-head'}, h('span', {class: 'muted', 'aria-hidden': 'true'}, '#'), h('h2', {}, b.name),
        signedIn ? null : h('span', {class: 'muted small'}, b.server));
      if (!now) return h('div', {class: 'board-card'}, head);
      const todo = h('section', {class: 'board-todo', 'aria-label': 'TODO'});
      const talk = h('section', {class: 'board-talk', tabindex: '0', 'aria-label': b.name});
      talk.append(timeline(talk, b.id, b.member));
      void boardTodo(b, todo);
      return h('div', {class: 'board-card'}, head, todo, talk);
    };

    /**
     * A board's TODO, pinned at the top of its box: Home's list, kept
     * together on the Remote (shown, not written, outside the server; not
     * shown at all there while it is empty). What others change is taken in
     * every little while, whenever nothing written here is waiting.
     */
    const boardTodo = async (b: Shown, holder: HTMLElement) => {
      const left = h('small', {class: 'muted'});
      const status = h('p', {class: 'error small', role: 'alert'});
      let list: servers.BoardTodo[];
      try { list = await servers.todos(b.id, b.member); } catch (e) { holder.replaceChildren(h('p', {class: 'error'}, message(e))); return; }
      if (!b.member && !list.length) { holder.remove(); return; }
      const keeper = b.member ? servers.todoKeeper(b.id, list) : null;
      const box = todoList(list, keeper ? (kept) => keeper.save(kept) : async () => {},
        {readOnly: !b.member, first: t('Something to do together'), counted: (x) => { left.textContent = x; }, failed: (why) => { status.textContent = why; }});
      writers.push(() => holder.contains(document.activeElement) || (keeper ? !keeper.idle() : false));
      holder.replaceChildren(h('div', {class: 'board-todo-head'}, h('span', {}, 'TODO'), left), box.element, status);
      let seen = JSON.stringify(list);
      const again = window.setInterval(async () => {
        if (!holder.isConnected) { clearInterval(again); return; }
        if (keeper && !keeper.idle()) return;
        const now = await servers.todos(b.id, b.member).catch(() => null);
        if (!now || (keeper && !keeper.idle()) || JSON.stringify(now) === seen) return;
        seen = JSON.stringify(now);
        keeper?.took(now);
        box.update(now);
      }, 15_000);
    };

    /** The last box: a new board in this server. */
    const newBoard = (now: boolean) => {
      if (!now) return h('div', {class: 'board-card board-new'}, h('header', {class: 'board-head'}, h('span', {class: 'muted'}, '+'), h('h2', {class: 'muted'}, t('New board'))));
      const name = h('input', {class: 'line-in', maxlength: '64', placeholder: t('What it is about'), 'aria-label': t('New board')}) as HTMLInputElement;
      const make = button(t('Make'), 'primary');
      const error = h('p', {class: 'error', role: 'alert'});
      writers.push(() => document.activeElement === name || !!name.value.trim());
      const done = async () => {
        if (!name.value.trim() || !serverId) return;
        make.disabled = true;
        try {
          const b = await servers.makeBoard(serverId, name.value);
          current()?.boards.push(b);
          show(serverId, b.id);
        } catch (e) { error.textContent = message(e); make.disabled = false; }
      };
      make.addEventListener('click', () => void done());
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void done(); } });
      return h('div', {class: 'board-card board-new'},
        h('header', {class: 'board-head'}, h('span', {class: 'muted'}, '+'), h('h2', {}, t('New board'))),
        h('div', {class: 'board-body'}, h('p', {class: 'muted'}, t('A board is one thing to talk about, with a TODO kept together: a trip, a release, a reading group.')),
          h('div', {class: 'row'}, name, make), error));
    };

    // ---- the servers, on the top line ----
    const paintTop = () => {
      gear.hidden = !serverId;
      if (!signedIn) { chips.replaceChildren(h('span', {class: 'muted'}, t('Open boards'))); return; }
      const each = list.map((s) => {
        const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(s.id === serverId), title: `${named(s.address)} · ${s.code}`}, s.name);
        b.addEventListener('click', () => show(s.id));
        return b;
      });
      // As Forge's band: + first, then what is out.
      const plus = h('button', {type: 'button', class: 'band-add', 'aria-label': t('Make a server'), title: t('Make a server')}, mark('plus')) as HTMLButtonElement;
      plus.addEventListener('click', () => { serverId = null; paintTop(); makeServer(); });
      chips.replaceChildren(plus, ...each);
    };

    /** No server chosen (or none yet): the one box makes a server, with a name on this Remote as a person has (first come, for five years at a time). */
    const makeServer = () => {
      shown = [];
      place('boards');
      const name = h('input', {class: 'line-in', maxlength: '64', placeholder: t('Its name'), 'aria-label': t('Make a server')}) as HTMLInputElement;
      const handle = h('input', {class: 'line-in mono', maxlength: '31', placeholder: 'trip', 'aria-label': t('Its address'), autocapitalize: 'off', spellcheck: 'false'}) as HTMLInputElement;
      // Its address follows its name until it is written itself.
      let own = false;
      const slug = (v: string) => v.toLowerCase().normalize('NFKD').replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 31);
      name.addEventListener('input', () => { if (!own) handle.value = slug(name.value); });
      handle.addEventListener('input', () => { own = handle.value !== ''; });
      const make = button(t('Make'), 'primary');
      const error = h('p', {class: 'error', role: 'alert'});
      writers.push(() => document.activeElement === name || document.activeElement === handle || !!name.value.trim());
      const done = async () => {
        if (!name.value.trim()) return;
        make.disabled = true;
        try {
          const s = await servers.makeServer(name.value, handle.value);
          list.push(s);
          show(s.id);
        } catch (e) {
          make.disabled = false;
          if (e instanceof RemoteError && e.status === 409 && /address/i.test(e.message)) {
            const inbox = button(t('Go to Inbox'), 'small-button');
            inbox.addEventListener('click', () => { this.close(); this.ctx.go('inbox'); });
            error.replaceChildren(t('A server needs your address. Claim one in Inbox.'), ' ', inbox);
          } else error.textContent = message(e);
        }
      };
      make.addEventListener('click', () => void done());
      for (const f of [name, handle]) f.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void done(); } });
      // What one removed or left last, still held: brought back with its name and boards.
      const back = h('div', {class: 'server-back'});
      void servers.goneServers().then((held) => back.replaceChildren(...held.map((g) => {
        const b = button(t('Bring back {name}', {name: g.name}), 'small-button');
        b.title = t('Held until {date}', {date: new Date(g.until).toLocaleDateString()});
        b.addEventListener('click', async () => { b.disabled = true; try { await servers.bringBack(g.id); list = await servers.servers(); show(g.id); } catch (e) { b.textContent = message(e); } });
        return b;
      }))).catch(() => {});
      track.replaceChildren(h('div', {class: 'slide', 'aria-current': 'true'}, h('div', {class: 'board-card board-new'},
        h('header', {class: 'board-head'}, h('span', {class: 'muted'}, '+'), h('h2', {}, t('Make a server'))),
        h('div', {class: 'board-body'},
          h('p', {}, t('A server is people you know: you add them from your Inbox contacts. Its boards are each a conversation and a TODO you keep together.')),
          name, h('div', {class: 'row server-address'}, handle), h('p', {class: 'muted small'}, t('Its name on this Remote, as a person has one: first come, nobody else\'s while it is the server\'s, for five years at a time, renewed by its owner.')),
          h('div', {class: 'row'}, make), error, back))));
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
      place('boards');
      paintTop();
      shown = s.boards.map((b) => ({id: b.id, name: b.name, member: true, guests: b.guests, server: s.name}));
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
      const note = h('p', {class: 'prompt-note muted small', role: 'status'});
      if (!b) { dock.replaceChildren(); return; }
      const guest = !b.member && b.guests ? servers.guestOf(b.id) : null;
      if (b.member || guest) {
        const field = h('textarea', {class: 'prompt-in', rows: '1', maxlength: String(servers.LIMIT), 'aria-label': t('Write in {board}', {board: b.name}),
          placeholder: b.member ? t('To the people of {server}', {server: b.server}) : t('As {name}, a guest', {name: guest!.as})}) as HTMLTextAreaElement;
        writers.push(() => document.activeElement === field || !!field.value.trim());
        const fit = () => { field.style.height = 'auto'; field.style.height = `${field.scrollHeight}px`; };
        let sending = false;
        field.addEventListener('input', fit);
        field.addEventListener('keydown', async (event) => {
          // As every box one writes in: Enter is a new line, Ctrl+Enter (⌘+Enter) sends.
          if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.isComposing) return;
          event.preventDefault();
          if (sending || !field.value.trim()) return;
          sending = true;
          note.replaceChildren();
          try { await postNow(b.id, field.value, guest?.token); field.value = ''; fit(); } catch (e) { note.textContent = message(e); } finally { sending = false; }
        });
        dock.replaceChildren(h('form', {class: 'prompt'}, field), note);
        if (this.pinned && b.member) field.focus();
        return;
      }
      if (b.guests) { dock.replaceChildren(guestIn(b), note); return; }
      const signIn = button(t('Sign in'), 'small-button');
      signIn.addEventListener('click', () => { this.close(); this.ctx.go('remote'); });
      dock.replaceChildren(h('div', {class: 'prompt server-say'},
        h('span', {class: 'muted'}, signedIn ? t('Only its people write here.') : t('Sign in to write.')), signedIn ? null : signIn));
    };

    /** An outsider, where the board takes guests: an email, the code sent to it, then the box. */
    const guestIn = (b: Shown) => {
      const email = h('input', {class: 'line-in', type: 'email', placeholder: t('Your email'), 'aria-label': t('Your email')}) as HTMLInputElement;
      const code = h('input', {class: 'line-in', inputmode: 'numeric', maxlength: '6', placeholder: t('The code sent to it'), 'aria-label': t('Code'), hidden: ''}) as HTMLInputElement;
      const ask = button(t('Send a code'), 'small-button');
      const error = h('span', {class: 'error small', role: 'alert'});
      writers.push(() => [email, code].includes(document.activeElement as HTMLInputElement));
      ask.addEventListener('click', async () => {
        error.textContent = '';
        try {
          if (code.hidden) { await servers.guestCode(b.id, email.value); code.hidden = false; ask.textContent = t('Check'); code.focus(); return; }
          await servers.guestCheck(b.id, email.value, code.value);
          paintDock(b);
        } catch (e) { error.textContent = message(e); }
      });
      return h('div', {class: 'prompt server-say'}, h('span', {class: 'muted'}, t('Write as a guest:')), email, code, ask, error);
    };

    // ---- the right: who is in it, then the repos they show in it ----
    const part = (title: string, ...body: (Node | null)[]) => h('section', {class: 'side-part'}, h('h3', {}, title), ...body);
    const faceOf = (address: string) => h('span', {class: 'face', 'aria-hidden': 'true'}, initials(address));
    const repoName = (r: servers.ShownRepo) => [h('span', {}, r.name), h('span', {class: 'muted small'}, named(r.owner))];
    let sideToken = 0;
    const paintSide = () => {
      const mine = ++sideToken;
      // Outside a server (an open board, or none chosen), whose it is is not told.
      work.classList.toggle('no-side', !serverId);
      if (!serverId) { side.replaceChildren(); return; }
      const id = serverId;
      void Promise.all([servers.people(id), servers.shownIn(id)]).then(([people, repos]) => {
        if (mine !== sideToken) return;
        side.replaceChildren(
          part(t('People'), h('ul', {class: 'people'}, ...people.map((p) => h('li', {}, faceOf(p.address), h('span', {}, named(p.address)),
            p.owner ? h('span', {class: 'muted small'}, t('owner')) : null)))),
          part(t('Repos'), repos.length
            ? h('ul', {class: 'side-repos'}, ...repos.map((r) => {
              const b = h('button', {type: 'button', class: 'side-repo', title: r.as ? t('Everyone sees it as {name}', {name: shownAs(r.as)}) : `${named(r.owner)}:${r.name}`},
                ...repoName(r), r.as ? h('span', {class: 'seen-mark muted small'}, t('everyone')) : null);
              b.addEventListener('click', () => void seeRepo(r));
              return h('li', {}, b);
            }))
            : h('div', {class: 'empty'}, t('None shown yet. Show one of yours behind the gear.'))));
      }).catch((e) => { if (mine === sideToken) side.replaceChildren(h('p', {class: 'error'}, message(e))); });
    };

    // ---- a repo shown: seen as it was last pushed, in the boards' place ----
    const seeRepo = async (r: servers.ShownRepo) => {
      place('repo');
      const as = `${r.owner}:${r.name}`;
      const back = button(t('Back to the boards'), 'small-button');
      back.addEventListener('click', () => toBoards());
      const forge = r.mine ? button(t('Open in Forge'), 'small-button') : null;
      forge?.addEventListener('click', () => { this.close(); this.ctx.openRepo(r.name); });
      const sub = h('p', {class: 'muted small'}, '…');
      const files = h('ul', {class: 'seen-files', 'aria-label': t('Files')});
      const text = h('pre', {class: 'seen-text', tabindex: '0'});
      sheet.replaceChildren(
        h('header', {class: 'sheet-head'}, h('div', {class: 'sheet-title'}, h('h2', {}, r.name), h('p', {}, named(r.owner))), h('span', {class: 'grow'}), forge, back),
        h('div', {class: 'sheet-sub'}, sub, r.as ? h('p', {class: 'muted small'}, t('Everyone sees it as {name}', {name: shownAs(r.as)})) : null),
        h('div', {class: 'seen-body'}, files, text));
      try {
        const got = await servers.seeRepo(as);
        sub.textContent = got.at ? t('Pushed {when}: {title}', {when: ago(got.at), title: got.title ?? ''}) : t('Nothing pushed yet');
        const paths = Object.entries(got.tree).filter((e): e is [string, string] => e[1] !== null).sort(([a], [b]) => a.localeCompare(b));
        const open = async (path: string, sha: string, row: HTMLElement) => {
          files.querySelectorAll('[aria-current]').forEach((x) => x.removeAttribute('aria-current'));
          row.setAttribute('aria-current', 'true');
          text.textContent = '…';
          try {
            const body = await servers.seeFile(as, sha);
            text.textContent = body.includes('\0') ? t('Not text') : body.length > SHOW_BYTES ? `${body.slice(0, SHOW_BYTES)}\n…` : body;
          } catch (e) { text.textContent = message(e); }
          text.setAttribute('aria-label', path);
        };
        files.replaceChildren(...paths.map(([path, sha]) => {
          const b = h('button', {type: 'button', class: 'seen-file mono small'}, path);
          b.addEventListener('click', () => void open(path, sha, b));
          return h('li', {}, b);
        }));
        const first = paths.findIndex(([p]) => /^readme(\.|$)/i.test(p));
        const pick = first >= 0 ? first : 0;
        if (paths[pick]) void open(paths[pick][0], paths[pick][1], files.querySelectorAll('button')[pick] as HTMLElement);
      } catch (e) { sub.textContent = message(e); }
    };

    // ---- behind the gear: what changes the server for everyone ----
    // In parts, as Remote's page is (its people, the repos shown, its boards,
    // the server itself): a small card for each thing, what can be done with
    // it at its foot, and what reaches past its people asked in the card.
    type Part = 'people' | 'repos' | 'boards' | 'server';
    const settings = async () => {
      const s = current();
      if (!s) return;
      place('settings');
      const done = button(t('Done'), 'small-button');
      done.addEventListener('click', () => toBoards());
      const tabs = parts<Part>('server-gear', [{id: 'people', label: t('People')}, {id: 'repos', label: t('Repos')}, {id: 'boards', label: t('Boards')}, {id: 'server', label: t('This server')}]);
      const ids: Part[] = ['people', 'repos', 'boards', 'server'];
      sheet.replaceChildren(
        h('header', {class: 'sheet-head'}, h('div', {class: 'sheet-title'}, h('h2', {}, s.name), h('p', {}, `${named(s.address)} · ${s.code}`)), h('span', {class: 'grow'}), done),
        h('div', {class: 'sheet-body'}, tabs.switch, ...ids.map((k) => tabs.panel(k))));
      const again = () => { if (showing === 'settings') void settings(); paintSide(); };
      // Narrow, the parts slide: the one chosen is kept in view.
      const inView = () => tabs.switch.querySelector('[aria-selected="true"]')?.scrollIntoView({block: 'nearest', inline: 'nearest'});
      tabs.onShow(inView);
      requestAnimationFrame(inView);
      const grid = (k: Part, ...cards: (Node | null)[]) => tabs.panel(k).replaceChildren(h('div', {class: 'grid small-grid'}, ...cards));
      /** A setting in a card: its word and a switch. Widening asks in the card first; narrowing is at once. */
      const setting = (card: HTMLElement, label: string, on: boolean, ask: {what: string | string[]; verb: string}, change: (v: boolean) => Promise<unknown>) => {
        const sw = h('button', {type: 'button', class: 'power plain', role: 'switch', 'aria-checked': String(on), 'aria-label': label}, h('span', {class: 'knob'})) as HTMLButtonElement;
        sw.addEventListener('click', async () => {
          if (!on) { askIn(card, card.querySelector('.card-title')?.textContent ?? '', ask.what, ask.verb, async () => { await change(true); again(); }); return; }
          sw.disabled = true;
          try { await change(false); again(); } catch { sw.disabled = false; }
        });
        return h('div', {class: 'card-row'}, h('span', {class: 'grow'}, label), sw);
      };
      try {
        const [people, repos, mineAll] = await Promise.all([servers.people(s.id), servers.shownIn(s.id), servers.seenAll()]);
        if (showing !== 'settings' || current() !== s) return;
        tabs.count('people', people.length);
        tabs.count('repos', repos.length);
        tabs.count('boards', s.boards.length);
        const mine = (await Promise.all(people.map(async (p) => ((await isMe(p.address)) ? p.address : null)))).find(Boolean) ?? null;

        // Its people: anyone in it adds someone they know; only its owner takes someone out.
        const add = h('button', {type: 'button', class: 'card small-card new'}, t('Add someone you know')) as HTMLButtonElement;
        add.addEventListener('click', async () => {
          const known = await import('../inbox.ts').then((inbox) => inbox.threads()).then((all) => all.filter((x) => x.state === 'contact' && !people.some((p) => p.address === x.address))).catch(() => []);
          const pick = h('div', {class: 'card small-card'}, h('span', {class: 'card-title'}, t('Add someone you know')),
            ...(known.length ? known.map((x) => {
              const b = button(named(x.address), 'small-button');
              b.addEventListener('click', async () => { b.disabled = true; try { await servers.addPerson(s.id, x.address); again(); } catch (e) { b.textContent = message(e); } });
              return b;
            }) : [line(t('Everyone you know is in it. Others come from your Inbox contacts.'))]));
          add.replaceWith(pick);
        });
        grid('people', ...people.map((p) => {
          const c = smallCard(named(p.address), line(p.owner ? t('owner') : p.address === mine ? t('you') : ''));
          if (s.owner && p.address !== mine) {
            const out = button(t('Remove'), 'small-button');
            out.addEventListener('click', () => askIn(c, named(p.address), t('{who} leaves {server}.', {who: named(p.address), server: s.name}),
              t('Remove'), async () => { await servers.removePerson(s.id, p.address); again(); }));
            c.append(foot(out));
          }
          return c;
        }), add);

        // The repos, as the boards: each of one's own with the two a board has, to its people and to everyone
        // (seen by everyone as the server's, never as oneself); others' shown here, as whose, its owner may take off.
        const shares = (name: string) => mineAll.find((x) => x.name === name)?.servers.map((x) => x.id) ?? [];
        const own = mineAll.map((x) => {
          const r = repos.find((y) => y.mine && y.name === x.name);
          const c = smallCard(x.name, r?.as && r.asServer !== s.id ? line(t('Everyone sees it as {name}', {name: shownAs(r.as)})) : null);
          c.append(setting(c, t('Show to its people'), !!r, {what: t('The people of {server} see it as last pushed.', {server: s.name}), verb: t('Show')},
            (v) => (v ? servers.showIn(s.id, x.name) : servers.takeOff(s.id, mine!, x.name))));
          if (s.address) {
            c.append(setting(c, t('Show to everyone'), r?.asServer === s.id, {what: [t('Anyone sees it as {name}.', {name: shownAs(`${s.address}:${x.name}`)}), t('Your name is not shown.')], verb: t('Show')},
              (v) => (v ? servers.setSeen(x.name, 'everyone', {as: s.id}) : servers.setSeen(x.name, 'servers', {servers: [...new Set([...shares(x.name), s.id])]}))));
          }
          return c;
        });
        const others = repos.filter((r) => !r.mine).map((r) => {
          const c = smallCard(r.name, line(named(r.owner)), r.as ? line(t('Everyone sees it as {name}', {name: shownAs(r.as)})) : null);
          if (s.owner) {
            const off = button(t('Remove'), 'small-button');
            off.addEventListener('click', async () => { off.disabled = true; try { await servers.takeOff(s.id, r.owner, r.name); again(); } catch (e) { off.textContent = message(e); } });
            c.append(foot(off));
          }
          return c;
        });
        grid('repos', ...own, ...others, own.length || others.length ? null : h('div', {class: 'empty'}, t('No repo on the Remote yet.')));

        // Its boards: how far each is open and removing one, its owner's to say; taking one home, anyone's.
        grid('boards', ...s.boards.map((b) => {
          const how = b.open ? (b.guests ? `${t('Seen by everyone')} · ${t('Guests can write')}` : t('Seen by everyone')) : t('Its people only');
          const c = smallCard(`# ${b.name}`, s.owner ? null : line(how));
          if (s.owner) {
            const set = (change: {open?: boolean; guests?: boolean}) => servers.setBoard(b.id, change).then((n) => { b.open = n.open; b.guests = n.guests; });
            c.append(
              setting(c, t('Show to everyone'), b.open, {what: t('Anyone reads #{board}, signed in or not.', {board: b.name}), verb: t('Show')}, (v) => set({open: v})),
              setting(c, t('Guests can write'), b.guests, {what: t('Others write in #{board} after an email check.', {board: b.name}), verb: t('Take guests')}, (v) => set({guests: v})));
          }
          const take = button(t('Take home'), 'small-button');
          take.title = t('Everything stays on the Remote. Take a copy as text when you want one here.');
          take.addEventListener('click', async () => {
            take.disabled = true;
            try {
              const text = await servers.archive(b.id, true);
              const a = h('a', {href: URL.createObjectURL(new Blob([text], {type: 'text/markdown'})), download: `${s.name}-${b.name}.md`.replace(/[^\w.-]+/g, '-')}) as HTMLAnchorElement;
              a.click();
              setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
            } catch (e) { take.textContent = message(e); } finally { take.disabled = false; }
          });
          const out = s.owner ? button(t('Remove'), 'small-button') : null;
          out?.addEventListener('click', () => askIn(c, `# ${b.name}`, [t('#{board} goes with its talk and TODO.', {board: b.name}), t('It cannot be undone.')], t('Remove'), async () => {
            await servers.removeBoard(b.id);
            s.boards = s.boards.filter((x) => x.id !== b.id);
            boardsChanged = true;
            again();
          }));
          c.append(h('div', {class: 'card-foot'}, out, h('span', {class: 'grow'}), take));
          return c;
        }));

        // The server itself: its name's term (renewed by its owner near its end), leaving it, and, its owner, removing it.
        const YEAR = 365 * 86_400_000, day = (ms: number) => new Date(ms).toLocaleDateString();
        const name = smallCard(named(s.address), line(`${t('Its code')} ${s.code}`),
          s.until ? line(s.until <= Date.now() ? t('Its term ended; held for it until {date}', {date: day(s.until + 30 * 86_400_000)}) : t('Until {date}', {date: day(s.until)})) : null);
        if (s.owner && s.until && s.until - Date.now() < YEAR) {
          const renew = button(t('Renew'), 'small-button primary');
          renew.addEventListener('click', async () => { renew.disabled = true; try { const r = await servers.renewServer(s.id); s.until = r.until; again(); } catch (e) { renew.textContent = message(e); } });
          name.append(foot(renew));
        }
        const leaving = mine ? smallCard(t('Leave this server'), line(s.owner ? t('It goes to whoever came next.') : '')) : null;
        if (leaving && mine) {
          const go = button(t('Leave'), 'small-button');
          go.addEventListener('click', () => askIn(leaving, t('Leave this server'), t('You leave {server}.', {server: s.name}), t('Leave'),
            async () => { await servers.removePerson(s.id, mine); gone(s.id); }));
          leaving.append(foot(go));
        }
        const removing = s.owner ? smallCard(t('Remove this server'), line(t('Held 30 days for you to bring back.'))) : null;
        if (removing) {
          const go = button(t('Delete'), 'small-button');
          go.addEventListener('click', () => askIn(removing, t('Remove this server'), [t('{server} goes, with its boards.', {server: s.name}), t('You can bring it back within 30 days.')], t('Delete'),
            async () => { await servers.removeServer(s.id); gone(s.id); }));
          removing.append(foot(go));
        }
        grid('server', name, leaving, removing);
      } catch (e) { tabs.panel(tabs.current()).replaceChildren(h('p', {class: 'error'}, message(e))); }
    };

    // ---- first: what there is ----
    if (signedIn) {
      void servers.servers().then((got) => {
        list = got;
        paintTop();
        const first = list.find((s) => s.id === at.server) ?? list[0];
        if (first) show(first.id); else makeServer();
      }).catch((e) => track.replaceChildren(h('p', {class: 'error'}, message(e))));
    } else {
      paintTop();
      paintSide();
      void servers.openBoards().then((got) => {
        shown = got.map((b) => ({id: b.id, name: b.name, member: false, guests: b.guests, server: b.server}));
        if (!shown.length) {
          track.replaceChildren(h('div', {class: 'slide', 'aria-current': 'true'}, h('div', {class: 'board-card board-new'},
            h('div', {class: 'board-body'}, h('p', {}, t('No board is open to everyone. Sign in to make a server with people you know.'))))));
          slides.classList.add('single');
          prev.hidden = next.hidden = true;
          paintDock(null);
          return;
        }
        track.replaceChildren(...shown.map(() => h('div', {class: 'slide'})));
        const i = shown.findIndex((b) => b.id === at.board);
        go(i >= 0 ? i : 0);
      }).catch((e) => track.replaceChildren(h('p', {class: 'error'}, message(e))));
    }

    return work;
  }
}
