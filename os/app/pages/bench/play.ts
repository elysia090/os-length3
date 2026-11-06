import type {AgentEvent, Done} from '../../agent/loop.ts';
import {gap, keyOf, leadIn} from '../../ui/cadence.ts';
import {still} from '../../ui/glide.ts';
import {strike} from '../../ui/keys.ts';

// The Agent's work as the person sees it. The Agent goes as fast as the model and the tools go (agent/loop.ts); what
// the person watches is played after it, one thing after another, at a person's pace, as a person would do it: a
// command typed into the box under Run, key by key with each key heard, then run; a file edited where it is, the old
// words going and the new typed in; a file read, gone to. The screen is never the Agent's interface: it is not shown
// it, nothing it does waits on a person, and a person at the keys or the mouse stops nothing.
//
// Only a command waits for the screen: the Prompt is the repo's one shell, so it runs once everything before it has
// been seen, and what it prints never comes before the edit it builds. A file the Agent writes is written at once (the
// repo, the Prompt's copy, Git have it), but the editor open on it is held back from taking it in (`holdBack`) until
// it is played there. What listens to the player (the pane's lines, the Agent's words) hears each event in its turn
// on screen, never ahead of it.

/** What the screen shows the Agent's work in: the box (a command typed under Run), and the file at a line. */
export interface Stage {
  /** The box taken for a command, Run chosen; `put` writes what is typed so far, `sent` brings the Prompt up as a run
   * sent from the box does (what it prints is seen), `done` gives the box back as it was, the Prompt down again. Null
   * when the box is not the repo's now (another repo in front): the command is run unseen typed. */
  typing(): {put(text: string): void; sent(): void; done(): void} | null;
  /** `path` brought into view at `line` (1-based); false when it cannot be (another repo in front). */
  reveal(path: string, line: number): boolean;
}

const key = (repo: string, path: string) => `${repo}\n${path}`;

/** The editors open on each repo's files: how each takes a text in (false: it asked, having unsaved edits of its own). */
const editors = new Map<string, {take(text: string): boolean; area: HTMLTextAreaElement}>();
/** The files the Agent is writing whose editors are held back: how many writes are still to be played, the latest
 * text written (null until one came while an editor was open on it), and whether the file was made by it (an editor
 * opened on it meanwhile starts empty, and the file is typed into it). */
const held = new Map<string, {count: number; text: string | null; made: boolean}>();

/** An editor open on `path` of `repo` (forge/reader.ts): the player types into it through `take`. */
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

/** Of what is written, at most this much is typed key by key; the rest comes in at once, as a paste does. */
const TYPED_MOST = 240;
/** An old piece this short goes a key at a time (Backspace); a longer one is chosen and goes at once. */
const BACKSPACED_MOST = 8;

/** One repo's Agent at work, played on screen. */
export class Player {
  readonly #repo: string;
  readonly #stage: Stage;
  #queue: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<(e: AgentEvent) => void>();

  constructor(repo: string, stage: Stage) {
    this.#repo = repo;
    this.#stage = stage;
  }

  /** Hear each event as the screen plays it, in order; returns how to stop hearing. */
  subscribe(fn: (e: AgentEvent) => void): () => void { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }

  /** Everything given so far, played. */
  idle(): Promise<void> { return this.#queue; }

  #then(act: () => Promise<void> | void): Promise<void> {
    this.#queue = this.#queue.then(act).catch(() => { /* a part not played is let go; the rest goes on */ });
    return this.#queue;
  }

  #told(e: AgentEvent) {
    for (const fn of [...this.#listeners]) {
      try { fn(e); } catch { this.#listeners.delete(fn); }
    }
  }

  /** An event of the Agent's: a file it is about to write is held back from its editor at once; played in its turn. */
  hear(e: AgentEvent): void {
    if (e.type === 'tool_execution_start' && (e.name === 'edit' || e.name === 'write') && typeof e.args.path === 'string') {
      const k = key(this.#repo, e.args.path), h = held.get(k);
      if (h) h.count++; else held.set(k, {count: 1, text: null, made: false});
    }
    // A file it made: an editor opened on it before it is played starts empty (the reader opens it about now).
    if (e.type === 'tool_execution_end' && e.done?.tool === 'write' && e.done.before === null) {
      const h = held.get(key(this.#repo, e.done.path));
      if (h) h.made = true;
    }
    void this.#then(async () => {
      if (e.type === 'tool_execution_end') await this.#done(e.name, e.args, e.done);
      this.#told(e);
    });
  }

  /** `command` typed into the box in its turn, then `run` (the Prompt runs it); what it gave back. */
  bash<T>(command: string, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      void this.#then(async () => {
        const box = await this.#type(command);
        try { resolve(await run()); } catch (e) { reject(e); } finally {
          // What it printed read a moment, as a person running it would, then the box given back.
          if (box) { await sleep(1400); box.done(); }
        }
      });
    });
  }

  /** `command` typed into the box and sent, the Prompt up; the box, to be given back once it has run. */
  async #type(command: string) {
    if (still()) return null;
    const box = this.#stage.typing();
    if (!box) return null;
    try {
      await sleep(leadIn());
      let typed = '', prev = '';
      for (const ch of command) {
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
      return box;
    } catch (e) { box.done(); throw e; }
  }

  /** What a file tool did, played: a file read gone to, an edit typed in where it is, a file written shown. */
  async #done(name: string, args: Record<string, unknown>, done: Done | undefined) {
    const path = typeof args.path === 'string' ? args.path : '';
    if (!done) { if (name === 'edit' || name === 'write') this.#release(path, null); return; }
    if (done.tool === 'read') {
      if (this.#stage.reveal(done.path, done.from) && !still()) await sleep(700);
    } else if (done.tool === 'edit') await this.#edit(done);
    else if (done.tool === 'write') await this.#write(done);
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

  /**
   * A file written whole, played: one it made typed into its editor from the top, key by key (past TYPED_MOST, the
   * rest at once); one it wrote over taken in at once, as a paste is.
   */
  async #write(d: Extract<Done, {tool: 'write'}>) {
    const k = key(this.#repo, d.path), e = editors.get(k), h = held.get(k);
    const shown = this.#stage.reveal(d.path, 1);
    if (!shown || still() || d.before !== null || !e?.area.isConnected || !h?.made || h.text === null) {
      if (shown && !still()) { await sleep(leadIn()); strike('enter'); }
      this.#release(d.path, d.text);
      return;
    }
    await sleep(450 + leadIn());
    const typed = d.text.slice(0, TYPED_MOST);
    let prev = '';
    for (let i = 0; i < typed.length; i++) {
      await sleep(gap(typed[i], prev));
      if (!e.take(typed.slice(0, i + 1))) break;
      if (document.activeElement === e.area) e.area.setSelectionRange(i + 1, i + 1);
      strike(keyOf(typed[i]));
      prev = typed[i];
    }
    if (d.text.length > typed.length) { await sleep(160); strike('enter'); }
    h.made = false;
    this.#release(d.path, d.text);
  }

  /** An edit typed in where it is: each piece in turn, the old words going and the new typed in, key by key. */
  async #edit(d: Extract<Done, {tool: 'edit'}>) {
    const k = key(this.#repo, d.path), e = editors.get(k), h = held.get(k);
    const shown = this.#stage.reveal(d.path, d.spans[0]?.line ?? 1);
    // The file as this edit left it: each piece replaced where it was, first in the file first.
    let now = d.before, moved = 0;
    for (const s of d.spans) {
      const at = offsetOf(d.before, s.line, s.column) + moved;
      now = now.slice(0, at) + s.new + now.slice(at + s.old.length);
      moved += s.new.length - s.old.length;
    }
    // Typed only where its editor was held back from taking it in, and is in view.
    if (!shown || !e?.area.isConnected || !h || h.text === null || still()) { this.#release(d.path, null); return; }
    await sleep(450);
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
