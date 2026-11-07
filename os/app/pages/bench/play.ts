import type {AgentEvent, Done} from '../../agent/loop.ts';
import {gap, keyOf, leadIn} from '../../ui/cadence.ts';
import {still} from '../../ui/glide.ts';
import {strike} from '../../ui/keys.ts';

// The Agent's work as the person sees it. The Agent goes as fast as the model and the tools go (agent/loop.ts), on
// files written at once and in a Prompt of its own (terminal.ts agentSessionFor); what the person watches is a part
// of it, played after it on the desk at a person's pace, as a person would do it: a command typed into the Prompt's
// line, key by key with each key heard, and what it printed shown; a file edited where it is, the old words going and
// the new typed in; a file made typed into its box from the top. Each box is a lane of its own and the lanes go side by
// side, so the work is seen going on in several places at once, each at a hand's pace; only what a command printed
// waits for what came before it, so an effect is never seen before its cause. What reads alone is not played; what is
// long is typed in part, the rest coming at once as a paste does. The screen is never the Agent's interface: it is not
// shown it, nothing it does waits on the screen, and a person at the keys or the mouse stops nothing.
//
// A file the Agent writes is written at once (the repo, the Prompts' copies, Git have it), but the editor open on it is
// held back from taking it in (`holdBack`) until it is played there. What listens to the player (the pane's lines, the
// Agent's words) hears each event once everything before it has been played.

/** What the screen shows the Agent's work in: the Prompt's line (a command typed), its flow (a run shown), the boxes. */
export interface Stage {
  /** The Prompt's line taken for a command, Run chosen; `put` writes what is typed so far, `sent` brings it into view
   * as sent, `done` gives the line back as it was. Null when the line is not the repo's now (another repo in front). */
  typing(): {put(text: string): void; sent(): void; done(): void} | null;
  /** A command shown run in the repo's Prompt with what it printed (the Agent ran it in a Prompt of its own). */
  shown(line: string, output: string, status: number | null): void;
  /** `path`'s box laid on the desk if it is not there, without taking the person's hand; false when it cannot be. */
  place(path: string): boolean;
  /** The camera over these boxes at once ('agent' is the Agent's terminal); none: back to the box in hand. */
  frame(keys: string[]): void;
  /** Whether these boxes are seen at once (none said: they are). */
  together?(keys: string[]): boolean;
  /** The file in front when the Agent was asked (what it was given to look at first), if any. */
  front?(): string | null;
}

/** An editor open on a file, as the player uses it: what it takes in, its text, and where the Agent's eye is in it (a
 * line, 1-based; null: nowhere). */
interface Editing { take(text: string): boolean; area: HTMLTextAreaElement; gaze?(line: number | null): void }

const key = (repo: string, path: string) => `${repo}\n${path}`;

/** The editors open on each repo's files: how each takes a text in (false: it asked, having unsaved edits of its own). */
const editors = new Map<string, Editing>();
/** The files the Agent is writing whose editors are held back: how many writes are still to be played, the latest
 * text written (null until one came while an editor was open on it), and whether the file was made by it (an editor
 * opened on it meanwhile starts empty, and the file is typed into it). */
const held = new Map<string, {count: number; text: string | null; made: boolean}>();

/** An editor open on `path` of `repo` (forge/desk-file.ts): the player types into it through `take`. */
export function editorOn(repo: string, path: string, editor: Editing) {
  editors.set(key(repo, path), editor);
}

/**
 * A text the Agent wrote to `path` of `repo`, come to the editor open on it: held back (true) while that write is still
 * to be played there; the editor takes it in itself otherwise.
 */
export function holdBack(repo: string, path: string, text: string): boolean {
  const k = key(repo, path), h = held.get(k), e = editors.get(k);
  if (!h || !e?.area.isConnected) return false;
  h.text = text;
  return true;
}

/**
 * What an editor opening on `path` of `repo` (`text`, as it stands) starts with: empty while the Agent's making of it
 * is still to be played (the text held back for it), else the text.
 */
export function openingWith(repo: string, path: string, text: string): string {
  const h = held.get(key(repo, path));
  if (!h?.made) return text;
  h.text = text;
  return '';
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The character offset in `text` of `line` and `column` (1-based, `column` in characters as the core counts them). */
function offsetOf(text: string, line: number, column: number): number {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const nl = text.indexOf('\n', at);
    if (nl < 0) return text.length;
    at = nl + 1;
  }
  for (let c = 1; c < column && at < text.length; c++) at += text.codePointAt(at)! > 0xffff ? 2 : 1;
  return at;
}

/** Of a piece written, at most this much is typed key by key; the rest comes in at once, as a paste does. Every edit
 * an agent makes is seen made: typed whole, unless it is a page or more. */
const TYPED_MOST = 1600;
/** Of a file made, at most this much. */
const MADE_MOST = 2400;
/** An old piece this long or shorter goes a key at a time, Backspace held after the first few as a hand holds it; a
 * longer one goes a line at a time. */
const BACKSPACED_MOST = 600;
/** Backspace pressed the first few times, then held: its repeat. */
const BACKSPACE_MS = 85, REPEAT_MS = 30;
/** The Agent's hand against a person's (cadence.ts gap): quick, and quicker still over a long piece, so that what it
 * writes is seen written and the playing keeps near the work. */
const hand = (length: number) => (length > 300 ? .3 : .55);
/** What a command printed, read a moment before the Prompt's line is given back. */
const READ_MS = 900;
/** A file read, its lines gone over by the eye: a line in this long, the whole read in at most READ_MOST (a long read
 * skims, a line in so many). */
const LINE_READ_MS = 110, READ_MOST = 2600;
/** While the Agent thinks (its model asked, nothing left to play), its eye goes on over what it last looked at, slower
 * than reading: a line in this long. */
const PONDER_MS = 420;
/** The playing's tempo against a hand's (each of its waits divided by it), no slower nor quicker than these: what the
 * Agent did is spread over the time its model takes to answer next, so that wait is not seen (filled with its work, a
 * little slower), and goes quicker once much is waiting to be played, so the playing keeps near the work. */
const SLOWEST = .55, QUICKEST = 2.2;
/** What its model is taken to need to answer, until it has been heard to: ms. */
const ANSWER_GUESS = 3500;
/** What is played is to end this long after the model is expected to answer, so the answer's work follows on it with no
 * gap; and, the Agent done, what is left is played in about TAIL_MS. */
const AFTER_MS = 1200, TAIL_MS = 6000;

/** What a hand takes to type `text` at a tempo of 1 (cadence.ts gap, its middle), `quick` its hand. */
function typing(text: string, quick: number): number {
  let ms = 0, prev = '';
  for (const ch of text) {
    ms += 110 + (prev === ' ' || prev === '\t' ? 14 : 0) + (/[A-Z~!@#$%^&*()_+{}|:"<>?]/.test(ch) ? 22 : 0) + (ch === '\n' ? 40 : 0) + (prev === '\n' ? 470 : 0);
    prev = ch;
  }
  return ms * quick;
}

/** A lead-in's middle (cadence.ts leadIn). */
const LEAD_MS = 550;

/** One repo's Agent at work, played on the desk. */
export class Player {
  readonly #repo: string;
  readonly #stage: Stage;
  /** Each lane's last act: 'agent' (its terminal) and each file's path. */
  readonly #lanes = new Map<string, Promise<void>>();
  /** The lanes at work now, which the camera frames. */
  readonly #working = new Set<string>();
  /** Acts put in their lanes and not yet begun (the eye stops going over a file at once for them). */
  #queued = 0;
  /** An act ended: what waits for a lane to be done hears it. */
  #ended: () => void = () => {};
  #anEnd = new Promise<void>((r) => { this.#ended = r; });
  #framing = 0;
  /** Lanes playing now: while none is, and the Agent thinks, its eye stays on what it last looked at (#ponder). */
  #busy = 0;
  /** The model asked and not yet answered (a turn under way, before what it does). */
  #thinking = false;
  /** The file the Agent's eye was last in, and where in it. */
  #looked: {path: string; line: number} | null = null;
  #pondering = false;
  /** The file the eye goes over while the Agent thinks (#ponder), not a lane at work. */
  #eyeOn: string | null = null;
  /** What is still to be played, at a tempo of 1 (ms): each act adds what it will take as it is put in its lane, each wait
   * of its takes its part away. */
  #owed = 0;
  /** When its model was last asked (0: it has answered), and what it takes to answer, as heard so far. */
  #askedAt = 0;
  #answerMs = ANSWER_GUESS;
  /** The Agent done: what is left goes on to its end a little quicker. */
  #done = false;
  /** What listeners hear, in order, each once all before it is played. */
  #told: Promise<void> = Promise.resolve();
  /** Everything of the turns before this one, played: what this turn does was decided on seeing it, so none of it is
   * played before it (side by side with what else this turn does, in other lanes, it may be). */
  #turnBefore: Promise<unknown> = Promise.resolve();
  readonly #listeners = new Set<(e: AgentEvent) => void>();

  constructor(repo: string, stage: Stage) {
    this.#repo = repo;
    this.#stage = stage;
  }

  /** Hear each event as the screen plays it, in order; returns how to stop hearing. */
  subscribe(fn: (e: AgentEvent) => void): () => void { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }

  /** Everything given so far, played. */
  async idle(): Promise<void> {
    await Promise.all([...this.#lanes.values(), this.#told]);
  }

  /** Every lane as it stands now (what is to be played before what comes next). */
  #before(): Promise<unknown> { return Promise.all([...this.#lanes.values()]); }

  /**
   * `act` played in `lane` after what is before it there, and after `after` too; `owes`, what it takes at a tempo of 1.
   * It waits through `wait` (`ms` at a tempo of 1, at the tempo then), each wait taking its part from what is owed; what
   * it did not take (played in part, or not at all) is let go as it ends.
   */
  #on(lane: string, act: (wait: (ms: number) => Promise<void>) => Promise<void>, after?: Promise<unknown>, owes = 0): Promise<void> {
    const prev = this.#lanes.get(lane) ?? Promise.resolve();
    this.#owed += owes;
    this.#queued++;
    let left = owes;
    const wait = (ms: number) => {
      const part = Math.min(ms, Math.max(0, left));
      left -= part;
      this.#owed -= part;
      return sleep(ms / this.#tempo());
    };
    const next = Promise.all([prev, after]).then(async () => {
      // Lanes go side by side only where they are seen side by side: else one at a time, so nothing is played out of
      // sight (a command typed while the camera is on a file read).
      while ([...this.#working].some((k) => k !== this.#eyeOn) && !(this.#stage.together?.([...this.#working, lane].filter((k) => k !== this.#eyeOn)) ?? true)) await this.#anEnd;
      this.#queued--;
      this.#busy++;
      this.#work(lane, true);
      try { await act(wait); } finally {
        this.#owed -= Math.max(0, left);
        left = 0;
        this.#busy--;
        this.#work(lane, false);
        const ended = this.#ended;
        this.#anEnd = new Promise<void>((r) => { this.#ended = r; });
        ended();
        this.#idleNow();
      }
    }).catch(() => { this.#queued = Math.max(0, this.#queued - 1); /* a part not played is let go; the rest goes on */ });
    this.#lanes.set(lane, next);
    return next;
  }

  /** The camera over the lanes at work (a frame later, so lanes starting together are framed together). */
  #work(lane: string, on: boolean) {
    if (on) this.#working.add(lane); else this.#working.delete(lane);
    if (still()) return;
    cancelAnimationFrame(this.#framing);
    this.#framing = requestAnimationFrame(() => this.#stage.frame([...this.#working]));
  }

  #tell(e: AgentEvent) {
    const before = this.#before();
    this.#told = Promise.all([this.#told, before]).then(() => {
      for (const fn of [...this.#listeners]) {
        try { fn(e); } catch { this.#listeners.delete(fn); }
      }
    });
  }

  /** The tempo now: while its model is asked, what is owed spread over the time till it answers (and a little after);
   * else as a hand goes, quicker as more waits; done, what is left in about TAIL_MS. */
  #tempo(): number {
    const owed = Math.max(0, this.#owed), clamp = (t: number) => Math.min(QUICKEST, Math.max(SLOWEST, t));
    if (this.#done) return clamp(Math.max(1, owed / TAIL_MS));
    if (this.#thinking && this.#askedAt) return clamp(owed / (Math.max(0, this.#askedAt + this.#answerMs - performance.now()) + AFTER_MS));
    return clamp(Math.max(1, owed / (this.#answerMs + AFTER_MS)));
  }

  /** An event of the Agent's: a file it is about to write is held back from its editor at once; played in its lane. */
  hear(e: AgentEvent): void {
    // Thinking from when its model is asked until it says or does something; the eye goes on meanwhile (#ponder). What
    // it took to answer is kept (most of the latest), for the tempo.
    if (e.type === 'agent_start' || e.type === 'turn_start') { this.#thinking = true; this.#askedAt = performance.now(); this.#idleNow(); }
    if (e.type === 'turn_start') this.#turnBefore = this.#before();
    if ((e.type === 'tool_execution_start' || e.type === 'message_end' || e.type === 'agent_end') && this.#askedAt) {
      this.#answerMs = .4 * this.#answerMs + .6 * (performance.now() - this.#askedAt);
      this.#askedAt = 0;
    }
    if (e.type === 'tool_execution_start' || e.type === 'message_end' || e.type === 'agent_end') this.#thinking = false;
    if (e.type === 'agent_end') this.#done = true;
    if (e.type === 'tool_execution_start' && (e.name === 'edit' || e.name === 'write') && typeof e.args.path === 'string') {
      const k = key(this.#repo, e.args.path), h = held.get(k);
      if (h) h.count++; else held.set(k, {count: 1, text: null, made: false});
    }
    // A file it made: an editor opened on it before it is played starts empty (the box is laid about now).
    if (e.type === 'tool_execution_end' && e.done?.tool === 'write' && e.done.before === null) {
      const h = held.get(key(this.#repo, e.done.path));
      if (h) h.made = true;
    }
    if (e.type === 'tool_execution_end') this.#play(e.name, e.args, e.done);
    this.#tell(e);
  }

  /** What a tool did, put in its lane: a run in the Prompt's, an edit or a file made in the file's, a read in the file's
   * as the eye going over what was read. */
  #play(name: string, args: Record<string, unknown>, done: Done | undefined) {
    const path = typeof args.path === 'string' ? args.path : '';
    const turn = this.#turnBefore;
    if (!done) { if (name === 'edit' || name === 'write') void this.#on(path, async () => this.#release(path, null), turn); return; }
    const owes = Player.#takes(done);
    if (done.tool === 'read') { const d = done; void this.#on(d.path, (w) => this.#read(d, w), turn, owes); return; }
    if (done.tool === 'bash') {
      const d = done;
      // Typed at once; what it printed shown once what came before it in the other lanes is played.
      void this.#on('agent', (w) => this.#run(d, w), this.#before(), owes);
    } else if (done.tool === 'edit') { const d = done; void this.#on(d.path, (w) => this.#edit(d, w), turn, owes); }
    else if (done.tool === 'write') { const d = done; void this.#on(d.path, (w) => this.#write(d, w), turn, owes); }
  }

  /** What playing `d` takes at a tempo of 1, as its waits add up (ms; a guess where its file is not yet seen). */
  static #takes(d: Done): number {
    if (d.tool === 'read') return LEAD_MS + Math.min(READ_MOST, Math.max(1, (d.to || d.lines) - (d.from || 1) + 1) * LINE_READ_MS) + 2 * LINE_READ_MS;
    if (d.tool === 'bash') return LEAD_MS + typing(d.command, hand(d.command.length)) + 150 + READ_MS;
    if (d.tool === 'write') { const t = d.text.slice(0, MADE_MOST); return d.before === null ? LEAD_MS + typing(t, hand(t.length)) : 0; }
    return 300 + d.spans.reduce((ms, sp) => {
      const typed = sp.new.slice(0, TYPED_MOST), old = sp.old.length <= BACKSPACED_MOST ? 4 * (BACKSPACE_MS + 10) + Math.max(0, sp.old.length - 4) * REPEAT_MS : 60 * sp.old.split('\n').length;
      return ms + LEAD_MS + old + typing(typed, hand(typed.length));
    }, 0);
  }

  /** The eye in `path` at `line` (null: out of it); kept as where it last was. */
  #gaze(path: string, line: number | null) {
    editors.get(key(this.#repo, path))?.gaze?.(line);
    if (line !== null) this.#looked = {path, line};
  }

  /** `path`'s box laid and its editor open (it opens a moment after its box is laid); false where it is not shown. */
  async #opened(path: string): Promise<Editing | null> {
    const k = key(this.#repo, path);
    if (!this.#stage.place(path) || still()) return null;
    for (let i = 0; i < 20 && !editors.get(k)?.area.isConnected; i++) await sleep(50);
    const e = editors.get(k);
    return e?.area.isConnected ? e : null;
  }

  /** A file read: its box laid, and the eye going down the lines read, a line at a time (skimming a long read). */
  async #read(d: Extract<Done, {tool: 'read'}>, wait: (ms: number) => Promise<void>) {
    const e = await this.#opened(d.path);
    if (!e) return;
    const last = Math.max(1, e.area.value.split('\n').length);
    const from = Math.min(Math.max(1, d.from || 1), last), to = Math.min(Math.max(from, d.to || last), last);
    const step = Math.max(1, Math.ceil(((to - from + 1) * LINE_READ_MS) / READ_MOST));
    await wait(leadIn());
    for (let line = from; line <= to; line += step) {
      this.#gaze(d.path, line);
      await wait(LINE_READ_MS);
    }
    this.#gaze(d.path, to);
    await wait(LINE_READ_MS * 2);
    this.#gaze(d.path, null);
    this.#looked = {path: d.path, line: from};
  }

  /** Nothing left to play: if the Agent is thinking, its eye goes on (#ponder). */
  #idleNow() {
    if (this.#thinking && !this.#busy && !this.#queued && !this.#pondering) void this.#ponder();
  }

  /**
   * While the Agent thinks (its model asked, nothing it did left to play), its eye stays at work: on the file it last
   * looked at, else the one in front when it was asked, going on down its lines slower than reading, and back to the top
   * at its end; it stops as soon as anything is to be played or the Agent says or does something. The screen is never
   * still while it works: the wait for its model is seen as it looking.
   */
  async #ponder() {
    const start = this.#looked ?? (this.#stage.front?.() ? {path: this.#stage.front!()!, line: 1} : null);
    if (!start || still()) return;
    this.#pondering = true;
    // It goes on while its model is asked and nothing it did is to be played; it stops the moment something is.
    const on = () => this.#thinking && !this.#busy && !this.#queued;
    try {
      const e = await this.#opened(start.path);
      if (!e || !on()) return;
      this.#eyeOn = start.path;
      this.#work(start.path, true);
      // Over its lines with words in them, as an eye goes (blank ones passed over); at the last it rests a while, as
      // one does at the end of a page, and goes back to the top. A file of one such line, it rests on it.
      let line = start.line;
      this.#gaze(start.path, line);
      while (on()) {
        const lines = e.area.value.split('\n');
        const worded = lines.flatMap((l, i) => (l.trim() ? [i + 1] : []));
        const next = worded.find((n) => n > line) ?? null;
        for (let t = 0, rest = next === null ? PONDER_MS * 4 : PONDER_MS; t < rest && on(); t += 60) await sleep(60);
        if (!on()) break;
        line = next ?? worded[0] ?? 1;
        this.#gaze(start.path, line);
      }
      this.#eyeOn = null;
      this.#work(start.path, false);
      editors.get(key(this.#repo, start.path))?.gaze?.(null);
    } finally {
      this.#eyeOn = null;
      this.#pondering = false;
    }
  }

  /** A command typed into the Prompt's line, sent, and what it printed shown. */
  async #run(d: Extract<Done, {tool: 'bash'}>, wait: (ms: number) => Promise<void>) {
    const box = still() ? null : this.#stage.typing();
    if (box) {
      try {
        await wait(leadIn());
        let typed = '', prev = '';
        for (const ch of d.command) {
          await wait(gap(ch, prev) * hand(d.command.length));
          typed += ch;
          box.put(typed);
          strike(keyOf(ch));
          prev = ch;
        }
        await wait(gap('\n', prev));
        strike('enter');
        box.put('');
        box.sent();
      } catch { /* the line is given back below */ }
    }
    this.#stage.shown(d.command, d.output, d.status);
    // Read a moment: no longer at work, the camera may go to where the work is.
    this.#work('agent', false);
    if (box) { await wait(READ_MS); box.done(); }
  }

  /**
   * A write to `path` played: the editor takes in the latest text the Agent wrote, once no other write to it is still
   * to be played; else `now`, what this one left it as. Null: nothing to take in from this one.
   */
  #release(path: string, now: string | null) {
    const k = key(this.#repo, path), h = held.get(k);
    if (!h) return;
    const e = editors.get(k);
    if (--h.count > 0) { if (now !== null && h.text !== null) e?.take(now); return; }
    held.delete(k);
    if (h.text !== null) e?.take(h.text);
  }

  /** A file written whole: one made typed into its box from the top (its first part); one written over, at once. */
  async #write(d: Extract<Done, {tool: 'write'}>, wait: (ms: number) => Promise<void>) {
    const k = key(this.#repo, d.path);
    const shown = this.#stage.place(d.path) && !still();
    // Its box laid now: its editor opens a moment after.
    for (let i = 0; i < 20 && shown && !editors.get(k)?.area.isConnected; i++) await sleep(50);
    const e = editors.get(k), h = held.get(k);
    if (!shown || d.before !== null || !e?.area.isConnected || !h?.made || h.text === null) {
      if (shown) strike('enter');
      this.#release(d.path, d.text);
      return;
    }
    await wait(leadIn());
    const typed = d.text.slice(0, MADE_MOST);
    let prev = '';
    for (let i = 0; i < typed.length; i++) {
      await wait(gap(typed[i], prev) * hand(typed.length));
      if (!e.take(typed.slice(0, i + 1))) break;
      strike(keyOf(typed[i]));
      prev = typed[i];
    }
    if (d.text.length > typed.length) { await wait(160); strike('enter'); }
    h.made = false;
    this.#release(d.path, d.text);
    this.#looked = {path: d.path, line: 1};
  }

  /** An edit typed in where it is: each piece in turn, the old words going and the new typed in (its first part). */
  async #edit(d: Extract<Done, {tool: 'edit'}>, wait: (ms: number) => Promise<void>) {
    const k = key(this.#repo, d.path);
    const shown = this.#stage.place(d.path) && !still();
    for (let i = 0; i < 20 && shown && !editors.get(k)?.area.isConnected; i++) await sleep(50);
    const e = editors.get(k), h = held.get(k);
    // The file as this edit left it: each piece replaced where it was, first in the file first.
    let now = d.before, moved = 0;
    for (const s of d.spans) {
      const at = offsetOf(d.before, s.line, s.column) + moved;
      now = now.slice(0, at) + s.new + now.slice(at + s.old.length);
      moved += s.new.length - s.old.length;
    }
    // Typed only where its editor was held back from taking it in, and is in view.
    if (!shown || !e?.area.isConnected || !h || h.text === null) { this.#release(d.path, null); return; }
    await wait(300);
    let cur = d.before, shift = 0;
    // Each step taken in, the caret (where the editor has the keyboard) where the hand is: after what was just typed.
    const take = (text: string, caret: number) => {
      cur = text;
      if (!e.take(text)) return false;
      if (document.activeElement === e.area) e.area.setSelectionRange(caret, caret);
      return true;
    };
    play: for (const s of d.spans) {
      const at = offsetOf(d.before, s.line, s.column) + shift;
      await wait(leadIn());
      if (s.old.length <= BACKSPACED_MOST) {
        // From its end, as Backspace takes it: a few presses, then held.
        for (let i = s.old.length, n = 0; i > 0; i--, n++) {
          if (!take(cur.slice(0, at + i - 1) + cur.slice(at + i), at + i - 1)) break play;
          if (n < 4 || n % 3 === 0) strike('key');
          await wait(n < 4 ? BACKSPACE_MS + 20 * Math.random() : REPEAT_MS);
        }
      } else {
        // A long piece: a line at a time from its end, each line chosen and gone.
        let left = s.old.length;
        while (left > 0) {
          const cut = s.old.lastIndexOf('\n', left - 2) + 1;
          if (!take(cur.slice(0, at + cut) + cur.slice(at + left), at + cut)) break play;
          strike('key');
          left = cut;
          await wait(60);
        }
      }
      let prev = '';
      const typed = s.new.slice(0, TYPED_MOST);
      for (let i = 0; i < typed.length; i++) {
        await wait(gap(typed[i], prev) * hand(typed.length));
        if (!take(cur.slice(0, at + i) + typed[i] + cur.slice(at + i), at + i + 1)) break play;
        strike(keyOf(typed[i]));
        prev = typed[i];
      }
      if (s.new.length > typed.length) {
        await wait(160);
        take(cur.slice(0, at + typed.length) + s.new.slice(typed.length) + cur.slice(at + typed.length), at + s.new.length);
        strike('enter');
      }
      shift += s.new.length - s.old.length;
    }
    this.#release(d.path, now);
    if (d.spans.length) this.#looked = {path: d.path, line: d.spans[0].line};
  }
}
