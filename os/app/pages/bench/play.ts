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
  /** The camera over these boxes at once ('term' is the Prompt's); none: back to the box in hand. */
  frame(keys: string[]): void;
}

const key = (repo: string, path: string) => `${repo}\n${path}`;

/** The editors open on each repo's files: how each takes a text in (false: it asked, having unsaved edits of its own). */
const editors = new Map<string, {take(text: string): boolean; area: HTMLTextAreaElement}>();
/** The files the Agent is writing whose editors are held back: how many writes are still to be played, the latest
 * text written (null until one came while an editor was open on it), and whether the file was made by it (an editor
 * opened on it meanwhile starts empty, and the file is typed into it). */
const held = new Map<string, {count: number; text: string | null; made: boolean}>();

/** An editor open on `path` of `repo` (forge/desk-file.ts): the player types into it through `take`. */
export function editorOn(repo: string, path: string, editor: {take(text: string): boolean; area: HTMLTextAreaElement}) {
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

/** Of a piece written, at most this much is typed key by key; the rest comes in at once, as a paste does. */
const TYPED_MOST = 80;
/** Of a file made, at most this much. */
const MADE_MOST = 200;
/** An old piece this short goes a key at a time (Backspace); a longer one is chosen and goes at once. */
const BACKSPACED_MOST = 8;
/** What a command printed, read a moment before the Prompt's line is given back. */
const READ_MS = 900;

/** One repo's Agent at work, played on the desk. */
export class Player {
  readonly #repo: string;
  readonly #stage: Stage;
  /** Each lane's last act: 'term' (the Prompt) and each file's path. */
  readonly #lanes = new Map<string, Promise<void>>();
  /** The lanes at work now, which the camera frames. */
  readonly #working = new Set<string>();
  #framing = 0;
  /** What listeners hear, in order, each once all before it is played. */
  #told: Promise<void> = Promise.resolve();
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

  /** `act` played in `lane` after what is before it there, and after `after` too. */
  #on(lane: string, act: () => Promise<void>, after?: Promise<unknown>): Promise<void> {
    const prev = this.#lanes.get(lane) ?? Promise.resolve();
    const next = Promise.all([prev, after]).then(async () => {
      this.#work(lane, true);
      try { await act(); } finally { this.#work(lane, false); }
    }).catch(() => { /* a part not played is let go; the rest goes on */ });
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

  /** An event of the Agent's: a file it is about to write is held back from its editor at once; played in its lane. */
  hear(e: AgentEvent): void {
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

  /** What a tool did, put in its lane: a run in the Prompt's, an edit or a file made in the file's; a read, not played. */
  #play(name: string, args: Record<string, unknown>, done: Done | undefined) {
    const path = typeof args.path === 'string' ? args.path : '';
    if (!done) { if (name === 'edit' || name === 'write') void this.#on(path, async () => this.#release(path, null)); return; }
    if (done.tool === 'bash') {
      const d = done;
      // Typed at once; what it printed shown once what came before it in the other lanes is played.
      void this.#on('term', () => this.#run(d), this.#before());
    } else if (done.tool === 'edit') { const d = done; void this.#on(d.path, () => this.#edit(d)); }
    else if (done.tool === 'write') { const d = done; void this.#on(d.path, () => this.#write(d)); }
  }

  /** A command typed into the Prompt's line, sent, and what it printed shown. */
  async #run(d: Extract<Done, {tool: 'bash'}>) {
    const box = still() ? null : this.#stage.typing();
    if (box) {
      try {
        await sleep(leadIn());
        let typed = '', prev = '';
        for (const ch of d.command) {
          await sleep(gap(ch, prev));
          typed += ch;
          box.put(typed);
          strike(keyOf(ch));
          prev = ch;
        }
        await sleep(gap('\n', prev));
        strike('enter');
        box.put('');
        box.sent();
      } catch { /* the line is given back below */ }
    }
    this.#stage.shown(d.command, d.output, d.status);
    // Read a moment: no longer at work, the camera may go to where the work is.
    this.#work('term', false);
    if (box) { await sleep(READ_MS); box.done(); }
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
  async #write(d: Extract<Done, {tool: 'write'}>) {
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
    await sleep(leadIn());
    const typed = d.text.slice(0, MADE_MOST);
    let prev = '';
    for (let i = 0; i < typed.length; i++) {
      await sleep(gap(typed[i], prev));
      if (!e.take(typed.slice(0, i + 1))) break;
      strike(keyOf(typed[i]));
      prev = typed[i];
    }
    if (d.text.length > typed.length) { await sleep(160); strike('enter'); }
    h.made = false;
    this.#release(d.path, d.text);
  }

  /** An edit typed in where it is: each piece in turn, the old words going and the new typed in (its first part). */
  async #edit(d: Extract<Done, {tool: 'edit'}>) {
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
    await sleep(300);
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
      await sleep(leadIn());
      if (s.old.length <= BACKSPACED_MOST) {
        for (let i = s.old.length; i > 0; i--) {
          if (!take(cur.slice(0, at + i - 1) + cur.slice(at + i), at + i - 1)) break play;
          strike('key');
          await sleep(70 + 20 * Math.random());
        }
      } else {
        if (!take(cur.slice(0, at) + cur.slice(at + s.old.length), at)) break;
        strike('key');
        await sleep(220);
      }
      let prev = '';
      const typed = s.new.slice(0, TYPED_MOST);
      for (let i = 0; i < typed.length; i++) {
        await sleep(gap(typed[i], prev));
        if (!take(cur.slice(0, at + i) + typed[i] + cur.slice(at + i), at + i + 1)) break play;
        strike(keyOf(typed[i]));
        prev = typed[i];
      }
      if (s.new.length > typed.length) {
        await sleep(160);
        take(cur.slice(0, at + typed.length) + s.new.slice(typed.length) + cur.slice(at + typed.length), at + s.new.length);
        strike('enter');
      }
      shift += s.new.length - s.old.length;
    }
    this.#release(d.path, now);
  }
}
