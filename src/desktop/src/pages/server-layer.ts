import {ago, h} from '../dom.ts';
import {mark} from '../icons.ts';
import {t} from '../i18n.ts';
import {connection, RemoteError} from '../remote.ts';
import * as servers from '../servers.ts';
import type {Context} from './context.ts';
import {postNow, timeline} from './talk.ts';

// Server is an operation, as File is: laid over whatever page is showing,
// never a page of its own. It is the one thing whose subject is people, not
// a repo: a server is a group of people who know each other, for talking
// loosely and planning in earnest, and each of its boards holds a plan they
// write together and the talk around it.
//
// It has the bench's shape. The servers one is in run as chips on the top
// line (+ makes one), and at its right end the server's gear. Under them its
// boards are boxes side by side, as the issues are: the board on screen in
// full, its neighbours' edges showing, an edge (or ← →) the way to them, and
// the last box a new board. A board's plan is pinned at the top of its box,
// written there in place by its people; its talk runs under it, and the box
// at the foot writes in it. On the right, where a repo's reference would be:
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

/** A button that asks first: pressed once it says `ask`, pressed again within a few seconds it does `act`. */
function twice(label: string, ask: string, act: () => Promise<void>, kind = 'link') {
  const b = button(label, kind);
  let armed = 0;
  b.addEventListener('click', async () => {
    if (!armed) {
      b.textContent = ask;
      b.classList.add('armed');
      armed = window.setTimeout(() => { armed = 0; b.textContent = label; b.classList.remove('armed'); }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = 0;
    b.disabled = true;
    try { await act(); } catch (e) { b.textContent = message(e); b.disabled = false; }
  });
  return b;
}

/**
 * A switch for something that reaches past the server's people: turning it
 * on says what it will do and waits for a yes; turning it off is at once.
 */
function reach(label: string, ask: string, yes: string, on: boolean, change: (v: boolean) => Promise<unknown>) {
  const sw = h('button', {type: 'button', class: 'power plain', role: 'switch', 'aria-checked': String(on), 'aria-label': label}, h('span', {class: 'knob'})) as HTMLButtonElement;
  const said = h('div', {class: 'sheet-ask', hidden: ''});
  const row = h('div', {class: 'sheet-switch'}, h('div', {class: 'sheet-row'}, h('span', {class: 'grow'}, label), sw), said);
  const set = async (v: boolean) => {
    sw.disabled = true;
    try { await change(v); sw.setAttribute('aria-checked', String(v)); said.hidden = true; } catch (e) { said.hidden = false; said.replaceChildren(h('span', {class: 'error'}, message(e))); } finally { sw.disabled = false; }
  };
  sw.addEventListener('click', () => {
    const v = sw.getAttribute('aria-checked') !== 'true';
    if (!v) { void set(false); return; }
    const go = button(yes, 'small-button primary'), not = button(t('Not now'), 'small-button');
    go.addEventListener('click', () => void set(true));
    not.addEventListener('click', () => { said.hidden = true; });
    said.replaceChildren(h('span', {class: 'grow'}, ask), not, go);
    said.hidden = false;
  });
  return row;
}

/** A board as the layer holds it: whose it is to write in. */
interface Shown { id: string; name: string; member: boolean; guests: boolean; server: string }

export class ServerLayer {
  readonly element: HTMLElement;
  private ctx: Context;
  private trigger: HTMLElement | null = null;
  private timer = 0;
  private pinned = false;
  /** Something being written here (a post, a plan, a name): it stays out while there is. */
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
    this.back = () => { if (showing === 'boards') return false; place('boards'); return true; };
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

    /** A board's box: in full where it is on screen (its plan pinned at the top, its talk under it), only its name beside it. */
    const card = (b: Shown, now: boolean) => {
      const head = h('header', {class: 'board-head'}, h('span', {class: 'muted', 'aria-hidden': 'true'}, '#'), h('h2', {}, b.name),
        signedIn ? null : h('span', {class: 'muted small'}, b.server));
      if (!now) return h('div', {class: 'board-card'}, head);
      const plan = h('section', {class: 'board-plan', 'aria-label': t('Plan')}, h('p', {class: 'muted small'}, '…'));
      const talk = h('section', {class: 'board-talk', tabindex: '0', 'aria-label': b.name});
      talk.append(timeline(talk, b.id, b.member));
      void servers.board(b.id, b.member).then((full) => plan.replaceChildren(...(b.member ? planEditor(full) : planRead(full))))
        .catch((e) => plan.replaceChildren(h('p', {class: 'error'}, message(e))));
      return h('div', {class: 'board-card'}, head, plan, talk);
    };

    const planRead = (full: servers.Board): Node[] => [
      h('div', {class: 'plan-head'}, h('span', {}, t('Plan')), full.version ? h('span', {class: 'muted'}, t('Version {n}', {n: full.version})) : null),
      h('div', {class: 'plan-read'}, full.plan || t('No plan yet'))];

    /** The plan, written where it is pinned: what changed is sent on its own, as hunks against the version it was made on. */
    const planEditor = (full: servers.Board): Node[] => {
      const field = h('textarea', {class: 'plan-in', rows: '1', 'aria-label': t('Plan'), placeholder: t('What you are going to do, and why')}) as HTMLTextAreaElement;
      field.value = full.plan;
      const fit = () => { field.style.height = 'auto'; field.style.height = `${field.scrollHeight + 2}px`; };
      requestAnimationFrame(fit);
      const state = h('span', {class: 'muted plan-state', role: 'status'});
      let base = full.version, was = full.plan, sending = false, again = false, wait = 0;
      const said = () => { state.textContent = base ? t('Version {n}', {n: base}) : ''; };
      said();
      writers.push(() => document.activeElement === field || field.value !== was);
      const save = async () => {
        clearTimeout(wait);
        if (sending) { again = true; return; }
        const now = field.value;
        if (now === was) return;
        sending = true;
        state.textContent = t('Saving…');
        try {
          const r = await servers.savePlan(full.id, base, was, now);
          if (r.ok) {
            base = r.version; was = r.plan;
            // Taken in with what others changed meanwhile: shown, unless more was typed since.
            if (r.merged && field.value === now) { field.value = r.plan; fit(); }
            state.textContent = r.merged ? t('Saved with what others changed meanwhile · version {n}', {n: base}) : t('Saved · version {n}', {n: base});
          } else {
            // The same lines changed by someone else: nothing is overwritten; both are offered.
            const theirs = button(t('Take theirs'), 'small-button'), keep = button(t('Keep mine over it'), 'small-button');
            theirs.addEventListener('click', () => { field.value = r.plan; fit(); base = r.version; was = r.plan; said(); });
            keep.addEventListener('click', () => { base = r.version; was = r.plan; void save(); });
            state.replaceChildren(t('Someone changed the same lines meanwhile.'), ' ', theirs, ' ', keep,
              h('pre', {class: 'plan-theirs'}, r.plan));
          }
        } catch (e) { state.textContent = message(e); } finally {
          sending = false;
          if (again) { again = false; void save(); }
        }
      };
      field.addEventListener('input', () => { fit(); clearTimeout(wait); wait = window.setTimeout(() => void save(), 1200); });
      field.addEventListener('blur', () => void save());
      return [h('div', {class: 'plan-head'}, h('span', {}, t('Plan')), state), field];
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
        h('div', {class: 'board-body'}, h('p', {class: 'muted'}, t('A board is one thing to talk about and plan: a trip, a release, a reading group.')),
          h('div', {class: 'row'}, name, make), error));
    };

    // ---- the servers, on the top line ----
    const paintTop = () => {
      gear.hidden = !serverId;
      if (!signedIn) { chips.replaceChildren(h('span', {class: 'muted'}, t('Open boards'))); return; }
      const each = list.map((s) => {
        const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(s.id === serverId), title: s.address}, s.name);
        b.addEventListener('click', () => show(s.id));
        return b;
      });
      const plus = h('button', {type: 'button', class: 'band-add', 'aria-label': t('Make a server'), title: t('Make a server')}, '+') as HTMLButtonElement;
      plus.addEventListener('click', () => { serverId = null; paintTop(); makeServer(); });
      chips.replaceChildren(...each, plus);
    };

    /** No server chosen (or none yet): the one box makes a server, named name@domain as a person is. */
    const makeServer = () => {
      shown = [];
      place('boards');
      const name = h('input', {class: 'line-in', maxlength: '64', placeholder: t('Its name'), 'aria-label': t('Make a server')}) as HTMLInputElement;
      const handle = h('input', {class: 'line-in mono', maxlength: '31', placeholder: 'trip', 'aria-label': t('Its address'), autocapitalize: 'off', spellcheck: 'false'}) as HTMLInputElement;
      const domain = h('span', {class: 'muted mono'}, '@…');
      void myself.then((m) => { if (m) domain.textContent = `@${m.domain}`; });
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
          h('p', {}, t('A server is people you know: you add them from your Inbox contacts. Its boards each hold a plan you write together and the talk around it.')),
          name, h('div', {class: 'row server-address'}, handle, domain), h('p', {class: 'muted small'}, t('Its address is a name like a person\'s: nobody else can have it while the server does.')),
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
          // As the prompt box: Enter sends, Shift+Enter is a new line.
          if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
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
    const repoName = (r: servers.ShownRepo) => [h('span', {class: 'mono'}, r.name), h('span', {class: 'muted small mono'}, r.owner)];
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
          part(t('People'), h('ul', {class: 'people'}, ...people.map((p) => h('li', {}, faceOf(p.address), h('span', {class: 'mono small'}, p.address),
            p.owner ? h('span', {class: 'muted small'}, t('owner')) : null)))),
          part(t('Repos'), repos.length
            ? h('ul', {class: 'side-repos'}, ...repos.map((r) => {
              const b = h('button', {type: 'button', class: 'side-repo', title: r.as ? t('Everyone sees it as {name}', {name: r.as}) : `${r.owner}:${r.name}`},
                ...repoName(r), r.as ? h('span', {class: 'seen-mark muted small'}, t('everyone')) : null);
              b.addEventListener('click', () => void seeRepo(r));
              return h('li', {}, b);
            }))
            : h('p', {class: 'muted small'}, t('None shown yet. Show one of yours behind the gear.'))));
      }).catch((e) => { if (mine === sideToken) side.replaceChildren(h('p', {class: 'error'}, message(e))); });
    };

    // ---- a repo shown: seen as it was last pushed, in the boards' place ----
    const seeRepo = async (r: servers.ShownRepo) => {
      place('repo');
      const as = `${r.owner}:${r.name}`;
      const back = button(t('Back to the boards'), 'small-button');
      back.addEventListener('click', () => place('boards'));
      const forge = r.mine ? button(t('Open in Forge'), 'small-button') : null;
      forge?.addEventListener('click', () => { this.close(); this.ctx.openRepo(r.name); });
      const sub = h('p', {class: 'muted small'}, '…');
      const files = h('ul', {class: 'seen-files', 'aria-label': t('Files')});
      const text = h('pre', {class: 'seen-text', tabindex: '0'});
      sheet.replaceChildren(h('div', {class: 'board-card sheet-card'},
        h('header', {class: 'board-head'}, h('h2', {class: 'mono'}, r.name), h('span', {class: 'muted small mono'}, r.owner), h('span', {class: 'grow'}), forge, back),
        h('div', {class: 'sheet-sub'}, sub, r.as ? h('p', {class: 'muted small'}, t('Everyone sees it as {name}', {name: r.as})) : null),
        h('div', {class: 'seen-body'}, files, text)));
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
    const settings = async () => {
      const s = current();
      if (!s) return;
      place('settings');
      const done = button(t('Done'), 'small-button');
      done.addEventListener('click', () => place('boards'));
      const body = h('div', {class: 'sheet-body'}, h('p', {class: 'muted small'}, '…'));
      sheet.replaceChildren(h('div', {class: 'board-card sheet-card'},
        h('header', {class: 'board-head'}, h('h2', {}, s.name), h('span', {class: 'muted small mono'}, s.address), h('span', {class: 'grow'}), done), body));
      const again = () => { if (showing === 'settings') void settings(); paintSide(); };
      try {
        const [people, repos, mineAll] = await Promise.all([servers.people(s.id), servers.shownIn(s.id), servers.seenAll()]);
        if (showing !== 'settings' || current() !== s) return;
        const section = (title: string, ...rows: (Node | null)[]) => h('section', {class: 'sheet-part'}, h('h3', {}, title), ...rows);

        // Who is in it: anyone in it adds someone they know; only its owner removes someone else.
        const add = h('select', {class: 'line-in', 'aria-label': t('Add someone you know'), hidden: ''}) as HTMLSelectElement;
        void import('../inbox.ts').then((inbox) => inbox.threads()).then((all) => {
          const known = all.filter((x) => x.state === 'contact' && !people.some((p) => p.address === x.address));
          if (!known.length) return;
          add.replaceChildren(h('option', {value: ''}, t('Add someone you know…')), ...known.map((x) => h('option', {value: x.address}, x.address)));
          add.hidden = false;
        }).catch(() => {});
        add.addEventListener('change', async () => {
          if (!add.value) return;
          try { await servers.addPerson(s.id, add.value); again(); } catch (e) { add.after(h('p', {class: 'error small'}, message(e))); }
        });
        const personRows = await Promise.all(people.map(async (p) => {
          const me = await isMe(p.address);
          const remove = s.owner && !me ? twice(t('Remove'), t('Remove {who}?', {who: p.address}), async () => { await servers.removePerson(s.id, p.address); again(); }) : null;
          return h('div', {class: 'sheet-row'}, faceOf(p.address), h('span', {class: 'mono small grow'}, p.address), p.owner ? h('span', {class: 'muted small'}, t('owner')) : null, remove);
        }));

        // The repos shown in it: one's own shown or taken off; seen by everyone as the server, never as oneself.
        const shares = (name: string) => mineAll.find((x) => x.name === name)?.servers.map((x) => x.id) ?? [];
        const repoRows = repos.map((r) => {
          const offList = r.mine || s.owner ? button(t('Take off'), 'small-button') : null;
          offList?.addEventListener('click', async () => { offList.disabled = true; try { await servers.takeOff(s.id, r.owner, r.name); again(); } catch (e) { offList.textContent = message(e); } });
          const asHere = `${s.address}:${r.name}`;
          const pub = r.mine && s.address
            ? reach(t('Anyone can see it, as {name}', {name: asHere}), t('Anyone will see {repo} as it was last pushed, as {name}, without your name.', {repo: r.name, name: asHere}), t('Show it to everyone'),
              r.asServer === s.id, (v) => (v ? servers.setSeen(r.name, 'everyone', {as: s.id}) : servers.setSeen(r.name, 'servers', {servers: shares(r.name)})).then(() => again()))
            : r.as ? h('p', {class: 'muted small'}, t('Everyone sees it as {name}', {name: r.as})) : null;
          return h('div', {class: 'sheet-item'}, h('div', {class: 'sheet-row'}, ...repoName(r), h('span', {class: 'grow'}), offList), pub);
        });
        const offer = h('select', {class: 'line-in', 'aria-label': t('Show one of yours'), hidden: ''}) as HTMLSelectElement;
        const notYet = mineAll.filter((x) => !repos.some((r) => r.mine && r.name === x.name));
        if (notYet.length) {
          offer.replaceChildren(h('option', {value: ''}, t('Show one of yours…')), ...notYet.map((x) => h('option', {value: x.name}, x.name)));
          offer.hidden = false;
        }
        offer.addEventListener('change', async () => {
          if (!offer.value) return;
          try { await servers.showIn(s.id, offer.value); again(); } catch (e) { offer.after(h('p', {class: 'error small'}, message(e))); }
        });

        // How far each board is open: its owner says, after a yes; anyone in it takes one home.
        const boardRows = s.boards.map((b) => {
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
          const head = h('div', {class: 'sheet-row'}, h('span', {class: 'muted', 'aria-hidden': 'true'}, '#'), h('span', {class: 'grow'}, b.name), take);
          if (!s.owner) {
            const how = b.open ? [t('Anyone can read it'), ...(b.guests ? [t('Outsiders can write, after an email check')] : [])].join(' · ') : t('Its people only');
            return h('div', {class: 'sheet-item'}, head, h('p', {class: 'muted small'}, how));
          }
          const set = (change: {open?: boolean; guests?: boolean}) => servers.setBoard(b.id, change).then((n) => { b.open = n.open; b.guests = n.guests; });
          return h('div', {class: 'sheet-item'}, head,
            reach(t('Anyone can read it'), t('Anyone, signed in or not, will read #{board}: its plan and its talk.', {board: b.name}), t('Open it'), b.open, (v) => set({open: v})),
            reach(t('Outsiders can write, after an email check'), t('Someone not in {server} will write in #{board} once a code sent to their email is checked.', {server: s.name, board: b.name}), t('Take guests'), b.guests, (v) => set({guests: v})));
        });

        // Leaving: one's own place; removing: its owner's, held a while to bring back.
        const myAddress = (await Promise.all(people.map(async (p) => ((await isMe(p.address)) ? p.address : null)))).find(Boolean) ?? null;
        const leave = myAddress ? twice(t('Leave this server'), t('Leave it?'), async () => { await servers.removePerson(s.id, myAddress); gone(s.id); }) : null;
        const remove = s.owner ? twice(t('Remove this server'), t('Remove {server}? It is held 30 days for you to bring back.', {server: s.name}), async () => { await servers.removeServer(s.id); gone(s.id); }) : null;

        body.replaceChildren(
          section(t('People'), ...personRows, add),
          section(t('Repos'), h('p', {class: 'muted small'}, t('Yours stay yours: shown here they are only seen, as they were last pushed.')), ...repoRows, offer),
          section(t('Boards'), h('p', {class: 'muted small'}, t('Its people always. Beyond them, only as far as its owner opens it.')), ...boardRows),
          section(t('This server'), h('div', {class: 'row'}, leave, remove)));
      } catch (e) { body.replaceChildren(h('p', {class: 'error'}, message(e))); }
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
