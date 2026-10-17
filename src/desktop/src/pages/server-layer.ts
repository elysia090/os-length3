import {h} from '../dom.ts';
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
// line (+ makes one); under them the server's boards are boxes side by side,
// as the issues are: the board on screen in full with its talk, its
// neighbours' edges showing, an edge (or ← →) the way to them, and the last
// box a new board. The box at the foot writes in the board on screen. On the
// right, where a repo's reference and Prompt would be: that board's plan,
// its people, who can see it, and taking it home as text.
//
// Resting the pointer on its icon brings it out, and it stays for LINGER
// after the pointer leaves; a press brings it out to stay. A press outside
// it, Escape, or a second press puts it away. While something is being
// written it stays.

const OPEN_DELAY = 300;
const LINGER = 8000;
const AT = 'length3.server.at';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const initials = (address: string) => [...address.split('@')[0]].slice(0, 2).join('').toUpperCase();
const button = (text: string, kind = '') => h('button', {type: 'button', class: `button ${kind}`.trim()}, text) as HTMLButtonElement;
function remembered(): {server?: string; board?: string} {
  try { return JSON.parse(localStorage.getItem(AT) ?? '{}') as {server?: string; board?: string}; } catch { return {}; }
}
function remember(at: {server?: string; board?: string}) {
  try { localStorage.setItem(AT, JSON.stringify(at)); } catch { /* a convenience */ }
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
    this.element.replaceChildren();
    this.element.remove();
    this.trigger?.setAttribute('aria-expanded', 'false');
  }

  private build(): HTMLElement {
    const signedIn = connection() !== null;
    const top = h('div', {class: 'server-top', role: 'radiogroup', 'aria-label': 'Server'});
    const track = h('div', {class: 'slide-track'});
    const prev = h('button', {type: 'button', class: 'stage-hit prev', 'aria-label': t('Previous board')}) as HTMLButtonElement;
    const next = h('button', {type: 'button', class: 'stage-hit next', 'aria-label': t('Next board')}) as HTMLButtonElement;
    const stage = h('div', {class: 'slide-stage', tabindex: '0', 'aria-label': t('Boards'), 'aria-roledescription': 'carousel'}, track, prev, next);
    const slides = h('div', {class: 'slides'}, stage);
    const dock = h('div', {class: 'dock'});
    const side = h('aside', {class: 'side server-side', 'aria-label': t('The board: its plan and its people')});
    const center = h('div', {class: 'center server-center'}, top, slides, dock);

    let list: servers.Server[] = [];
    let shown: Shown[] = [];
    let serverId: string | null = null;
    let k = 0;
    const at = remembered();
    const writers: (() => boolean)[] = [];
    this.writing = () => writers.some((f) => f());

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
      paintSide(b ?? null);
    };
    prev.addEventListener('click', () => go(k - 1));
    next.addEventListener('click', () => go(k + 1));
    stage.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(k - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(k + 1); }
    });

    /** What the board on screen shows: its talk, or its plan. */
    const face = new Map<string, 'talk' | 'plan'>();
    /** A board's box: in full where it is on screen (its talk, or its plan to write), only its name beside it. */
    const card = (b: Shown, current: boolean) => {
      const head = h('header', {class: 'board-head'}, h('span', {class: 'muted', 'aria-hidden': 'true'}, '#'), h('h2', {}, b.name),
        signedIn ? null : h('span', {class: 'muted small'}, b.server));
      if (!current) return h('div', {class: 'board-card'}, head);
      const box = h('div', {class: 'board-card'}, head);
      const now = face.get(b.id) ?? 'talk';
      // Talk and Plan: the board turns over, as a page in parts does; the plan is written here, not on the side.
      const faces = h('div', {class: 'chips board-faces', role: 'radiogroup', 'aria-label': b.name}, ...(['talk', 'plan'] as const).map((f) => {
        const c = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(f === now)}, f === 'talk' ? t('Talk') : t('Plan'));
        c.addEventListener('click', () => { if (f !== (face.get(b.id) ?? 'talk')) { face.set(b.id, f); box.replaceWith(card(b, true)); } });
        return c;
      }));
      head.append(faces);
      if (now === 'talk') {
        const talk = h('section', {class: 'board-talk', tabindex: '0', 'aria-label': b.name});
        talk.append(timeline(talk, b.id, b.member));
        box.append(talk);
      } else {
        const plan = h('section', {class: 'board-plan', 'aria-label': t('Plan')}, h('p', {class: 'muted small'}, '…'));
        box.append(plan);
        void servers.board(b.id, b.member).then((full) => plan.replaceChildren(...(b.member ? planEditor(full) : [h('div', {class: 'plan-read'}, full.plan || t('No plan yet'))])))
          .catch((e) => plan.replaceChildren(h('p', {class: 'error'}, message(e))));
      }
      return box;
    };

    /** The last box: a new board in this server. */
    const newBoard = (current: boolean) => {
      if (!current) return h('div', {class: 'board-card board-new'}, h('header', {class: 'board-head'}, h('span', {class: 'muted'}, '+'), h('h2', {class: 'muted'}, t('New board'))));
      const name = h('input', {class: 'line-in', maxlength: '64', placeholder: t('What it is about'), 'aria-label': t('New board')}) as HTMLInputElement;
      const make = button(t('Make'), 'primary');
      const error = h('p', {class: 'error', role: 'alert'});
      writers.push(() => document.activeElement === name || !!name.value.trim());
      const done = async () => {
        if (!name.value.trim() || !serverId) return;
        make.disabled = true;
        try {
          const b = await servers.makeBoard(serverId, name.value);
          const s = list.find((x) => x.id === serverId);
          s?.boards.push(b);
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
      if (!signedIn) { top.replaceChildren(h('span', {class: 'muted'}, t('Open boards'))); return; }
      const chips = list.map((s) => {
        const b = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(s.id === serverId)}, s.name);
        b.addEventListener('click', () => show(s.id));
        return b;
      });
      const plus = h('button', {type: 'button', class: 'band-add', 'aria-label': t('Make a server'), title: t('Make a server')}, '+') as HTMLButtonElement;
      plus.addEventListener('click', () => { serverId = null; paintTop(); makeServer(); });
      top.replaceChildren(...chips, plus);
    };

    /** No server chosen (or none yet): the one box makes a server. */
    const makeServer = () => {
      shown = [];
      const name = h('input', {class: 'line-in', maxlength: '64', placeholder: t('Its name'), 'aria-label': t('Make a server')}) as HTMLInputElement;
      const make = button(t('Make'), 'primary');
      const error = h('p', {class: 'error', role: 'alert'});
      writers.push(() => document.activeElement === name || !!name.value.trim());
      const done = async () => {
        if (!name.value.trim()) return;
        make.disabled = true;
        try {
          const s = await servers.makeServer(name.value);
          list.push(s);
          show(s.id);
        } catch (e) {
          make.disabled = false;
          if (e instanceof RemoteError && e.status === 409) {
            const inbox = button(t('Go to Inbox'), 'small-button');
            inbox.addEventListener('click', () => { this.close(); this.ctx.go('inbox'); });
            error.replaceChildren(t('A server needs your address. Claim one in Inbox.'), ' ', inbox);
          } else error.textContent = message(e);
        }
      };
      make.addEventListener('click', () => void done());
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void done(); } });
      track.replaceChildren(h('div', {class: 'slide', 'aria-current': 'true'}, h('div', {class: 'board-card board-new'},
        h('header', {class: 'board-head'}, h('span', {class: 'muted'}, '+'), h('h2', {}, t('Make a server'))),
        h('div', {class: 'board-body'},
          h('p', {}, t('A server is people you know: you add them from your Inbox contacts. Its boards each hold a plan you write together and the talk around it.')),
          h('div', {class: 'row'}, name, make), error))));
      slides.classList.add('single');
      track.style.setProperty('--at', '0');
      prev.hidden = next.hidden = true;
      paintDock(null);
      paintSide(null);
      if (this.pinned) name.focus();
    };

    /** Show server `id`, at board `board` (or the one last seen, or its first). */
    const show = (id: string, board?: string) => {
      const s = list.find((x) => x.id === id);
      if (!s) { makeServer(); return; }
      serverId = id;
      paintTop();
      shown = s.boards.map((b) => ({id: b.id, name: b.name, member: true, guests: b.guests, server: s.name}));
      track.replaceChildren(...[...shown, null].map(() => h('div', {class: 'slide'})));
      const want = board ?? (at.server === id ? at.board : undefined);
      const i = shown.findIndex((b) => b.id === want);
      go(i >= 0 ? i : 0);
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

    // ---- the right: the board's plan, its people, who can see it, taking it home ----
    let sideToken = 0;
    const paintSide = (b: Shown | null) => {
      const mine = ++sideToken;
      if (!b) { side.replaceChildren(); return; }
      side.replaceChildren(h('p', {class: 'muted small'}, '…'));
      void servers.board(b.id, b.member).then((full) => {
        if (mine !== sideToken) return;
        side.replaceChildren(planPart(full), ...(b.member ? [peoplePart(full)] : []), seePart(full, b.member), homePart(full, b.member));
      }).catch((e) => { if (mine === sideToken) side.replaceChildren(h('p', {class: 'error'}, message(e))); });
    };

    const part = (title: string, ...body: (Node | null)[]) => h('section', {class: 'side-part'}, h('h3', {}, title), ...body);

    /** On the side the plan is read, never written: it is written in the board's box. */
    const planPart = (full: servers.Board) => part(t('Plan'),
      h('div', {class: 'plan-read'}, full.plan || t('No plan yet')),
      full.version ? h('p', {class: 'muted small'}, t('Version {n}', {n: full.version})) : null);

    /** The plan written in the board's box: the text is the field; what changed is sent on its own, as hunks against the version it was made on. */
    const planEditor = (full: servers.Board): Node[] => {
      const field = h('textarea', {class: 'plan-in', 'aria-label': t('Plan'), placeholder: t('What you are going to do, and why')}) as HTMLTextAreaElement;
      field.value = full.plan;
      const state = h('p', {class: 'muted small plan-state', role: 'status'});
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
            if (r.merged && field.value === now) field.value = r.plan;
            state.textContent = r.merged ? t('Saved with what others changed meanwhile · version {n}', {n: base}) : t('Saved · version {n}', {n: base});
            paintSide(shown[k]);
          } else {
            // The same lines changed by someone else: nothing is overwritten; both are offered.
            const theirs = button(t('Take theirs'), 'small-button'), keep = button(t('Keep mine over it'), 'small-button');
            theirs.addEventListener('click', () => { field.value = r.plan; base = r.version; was = r.plan; said(); });
            keep.addEventListener('click', () => { base = r.version; was = r.plan; void save(); });
            state.replaceChildren(t('Someone changed the same lines meanwhile.'), ' ', theirs, ' ', keep,
              h('pre', {class: 'plan-theirs'}, r.plan));
          }
        } catch (e) { state.textContent = message(e); } finally {
          sending = false;
          if (again) { again = false; void save(); }
        }
      };
      field.addEventListener('input', () => { clearTimeout(wait); wait = window.setTimeout(() => void save(), 1200); });
      field.addEventListener('blur', () => void save());
      if (this.pinned) setTimeout(() => field.focus(), 0);
      return [field, state];
    };

    /** Who is in the server, and adding someone you know. */
    const peoplePart = (full: servers.Board) => {
      const ul = h('ul', {class: 'people'}, ...(full.people ?? []).map((p) => h('li', {},
        h('span', {class: 'face', 'aria-hidden': 'true'}, initials(p.address)), h('span', {class: 'mono small'}, p.address),
        p.owner ? h('span', {class: 'muted small'}, t('owner')) : null)));
      const add = h('select', {class: 'line-in', 'aria-label': t('Add someone you know')}) as HTMLSelectElement;
      add.hidden = true;
      void import('../inbox.ts').then((inbox) => inbox.threads()).then((all) => {
        const known = all.filter((x) => x.state === 'contact' && !(full.people ?? []).some((p) => p.address === x.address));
        if (!known.length) return;
        add.replaceChildren(h('option', {value: ''}, t('Add someone you know…')), ...known.map((x) => h('option', {value: x.address}, x.address)));
        add.hidden = false;
      }).catch(() => {});
      add.addEventListener('change', async () => {
        if (!add.value) return;
        try { await servers.addPerson(full.server.id, add.value); paintSide(shown[k]); } catch (e) { add.after(h('p', {class: 'error small'}, message(e))); }
      });
      const leave = h('button', {type: 'button', class: 'button link'}, t('Leave this server')) as HTMLButtonElement;
      let armed = 0;
      leave.addEventListener('click', async () => {
        if (!armed) { leave.textContent = t('Leave it?'); armed = window.setTimeout(() => { armed = 0; leave.textContent = t('Leave this server'); }, 3000); return; }
        try {
          const myself = await import('../inbox.ts').then((inbox) => inbox.me());
          const address = (full.people ?? []).find((p) => myself.addresses.some((a) => a.address === p.address))?.address;
          if (!address) return;
          await servers.removePerson(full.server.id, address);
          list = list.filter((s) => s.id !== full.server.id);
          if (list[0]) show(list[0].id); else makeServer();
        } catch (e) { leave.textContent = message(e); }
      });
      return part(t('People'), ul, add, leave);
    };

    /** How far the board is open: to anyone reading, to outsiders writing. Its people choose. */
    const seePart = (full: servers.Board, member: boolean) => {
      const row = (label: string, on: boolean, change: (v: boolean) => Promise<unknown>) => {
        const sw = h('button', {type: 'button', class: 'power plain', role: 'switch', 'aria-checked': String(on), 'aria-label': label}, h('span', {class: 'knob'})) as HTMLButtonElement;
        sw.addEventListener('click', async () => {
          const v = sw.getAttribute('aria-checked') !== 'true';
          sw.disabled = true;
          try { await change(v); sw.setAttribute('aria-checked', String(v)); } catch { /* left as it was */ } finally { sw.disabled = false; }
        });
        return h('div', {class: 'switch-row'}, h('span', {}, label), sw);
      };
      // Outside it, how far it is open is said, not offered.
      if (!member) return part(t('Who can see it'), h('p', {class: 'muted small'}, [t('Anyone can read it'), ...(full.guests ? [t('Outsiders can write, after an email check')] : [])].join(' · ')));
      return part(t('Who can see it'),
        h('p', {class: 'muted small'}, t('Its people always. Beyond them, only as far as you open it.')),
        row(t('Anyone can read it'), full.open, (v) => servers.setBoard(full.id, {open: v})),
        row(t('Outsiders can write, after an email check'), full.guests, (v) => servers.setBoard(full.id, {guests: v})));
    };

    /** Taking it home: the plan and the talk as one text file. */
    const homePart = (full: servers.Board, member: boolean) => {
      const take = (what: {plan?: boolean; talk?: boolean}, label: string) => {
        const b = button(label, 'small-button');
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            const text = await servers.archive(full.id, member, what);
            const a = h('a', {href: URL.createObjectURL(new Blob([text], {type: 'text/markdown'})),
              download: `${full.server.name}-${full.name}${what.talk === false ? '-plan' : ''}.md`.replace(/[^\w.-]+/g, '-')}) as HTMLAnchorElement;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
          } catch (e) { b.textContent = message(e); } finally { b.disabled = false; }
        });
        return b;
      };
      return part(t('Take it home'),
        h('p', {class: 'muted small'}, t('Everything stays on the Remote. Take a copy as text when you want one here.')),
        h('div', {class: 'row'}, take({}, t('Plan and talk')), take({talk: false}, t('Plan only'))));
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

    return h('div', {class: 'work no-strip'}, center, side);
  }
}
