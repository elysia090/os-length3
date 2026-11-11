import {AgentError, type Use} from './ask.ts';
import {talkTo, type Call, type Given, type Talk, type ToolSpec} from './talk.ts';

// The Agent, Pi's loop made thin. Asked something, it asks the model, does the tools the model calls one after
// another, gives back what they gave, and goes on until the model calls none: its last words are what it says it
// did. The transcript is its only state (talk.ts). It is never shown the screen: its hands (`Hands`, given by what
// holds the repo) do each tool through the OS's own calls, and what they did comes back to the model as text.
//
// What it does is said as it happens (`AgentEvent`, Pi's events) to whoever listens: an agent's hooks (what the
// journal shows of any agent at work), and the screen, which plays each event as a person's doing at a person's
// pace (pages/bench/play.ts) while this goes on as fast as the model and the tools go. Nothing that listens holds
// it up, and a person at the keys or the mouse does not stop it: the screen is not its interface.

/** What a read gave: the lines the model reads (and where reading goes on, said in them), which of the file's. */
export interface Read { text: string; from: number; to: number; lines: number }
/** Where an edit replaced a piece: its first line and column in the file as it was, what it was and is now. */
export interface Span { line: number; column: number; old: string; new: string }
/** A file edited: the file as it was, where each piece was replaced, the lines added and taken. */
export interface Edited { before: string; spans: Span[]; added: number; removed: number }
/** A file written whole: as it was (null: it was made), the lines added and taken. */
export interface Written { before: string | null; added: number; removed: number }
/** A command run: all it printed, how it ended (null: not known), and what of it the model is given. */
export interface Ran { output: string; status: number | null; given: string }

/** What the Agent can do in the repo: read, run (its own Prompt), and on work handed to it, edit and write. */
export interface Hands {
  read(path: string, offset?: number, limit?: number): Promise<Read>;
  run(command: string): Promise<Ran>;
  /** Absent on main: the Agent writes only on work handed to it (an issue started). */
  edit?: (path: string, edits: {oldText: string; newText: string}[]) => Promise<Edited>;
  write?: (path: string, content: string) => Promise<Written>;
}

/** What a tool did, as the screen plays it: the file and where, or the command and what it printed. */
export type Done =
  | ({tool: 'read'; path: string} & Read)
  | ({tool: 'bash'; command: string} & Ran)
  | ({tool: 'edit'; path: string} & Edited)
  | ({tool: 'write'; path: string; text: string} & Written);

export type ToolName = Done['tool'];

/** What the Agent does, as it happens (Pi's events, those a listener here needs). */
export type AgentEvent =
  | {type: 'agent_start'; question: string}
  | {type: 'turn_start'}
  /** The model's words in a turn (before the tools it calls). */
  | {type: 'message_end'; text: string}
  | {type: 'tool_execution_start'; id: string; name: string; args: Record<string, unknown>}
  /** `done` is absent when it failed: `result` says why. */
  | {type: 'tool_execution_end'; id: string; name: string; args: Record<string, unknown>; result: string; isError: boolean; done?: Done}
  | {type: 'turn_end'}
  /** Its last words, or why it stopped. */
  | {type: 'agent_end'; said: string; error?: AgentError};

/** At most this many turns of the model's in one piece of work. */
const TURNS = 24;

const string = {type: 'string'};
const TOOLS: Record<ToolName, ToolSpec> = {
  read: {name: 'read', description: 'Read a file of the repo, by its path from the repo\'s top folder. Gives at most 2000 lines or 50 KB; use offset (the first line, from 1) and limit (how many lines) for more.',
    parameters: {type: 'object', properties: {path: string, offset: {type: 'number'}, limit: {type: 'number'}}, required: ['path']}},
  bash: {name: 'bash', description: 'Run a shell command in the repo\'s Prompt (sh, in the repo\'s top folder: make, cc, gdb, the tests, ls, grep). Gives back the last 2000 lines or 50 KB it printed, and its exit status.',
    parameters: {type: 'object', properties: {command: string}, required: ['command']}},
  edit: {name: 'edit', description: 'Edit a file of the repo by exact text replaced. Each edits[].oldText must be in the file once, as it is (every space and line), and not overlap another; all are matched against the file as it was. Two changes near each other: make them one edit.',
    parameters: {type: 'object', properties: {path: string, edits: {type: 'array', items: {type: 'object', properties: {oldText: string, newText: string}, required: ['oldText', 'newText']}}}, required: ['path', 'edits']}},
  write: {name: 'write', description: 'Write a file of the repo whole, by its path from the repo\'s top folder: made if it is not there, its folders too.',
    parameters: {type: 'object', properties: {path: string, content: string}, required: ['path', 'content']}},
};

/** The tools `hands` offers, in the order the model is told them. */
const toolsOf = (hands: Hands): ToolName[] => (hands.edit && hands.write ? ['read', 'bash', 'edit', 'write'] : ['read', 'bash']);

/** A hook before a tool: given what is called, it may refuse it (its words go back to the model as the tool's). */
export type Before = (call: Call) => Promise<string | void> | string | void;
/** A hook after a tool: given what it gave back, it may say something else to the model instead. */
export type After = (call: Call, result: Given) => Promise<string | void> | string | void;

export interface AgentOptions {
  use: Use;
  system: string;
  hands: Hands;
  signal?: AbortSignal;
  before?: Before;
  after?: After;
  /** The conversation (talk.ts by default: a maker's API). */
  talk?: Talk;
}

/** `call` done with `hands`: what goes back to the model, and what was done (absent: it failed). */
async function done(call: Call, hands: Hands): Promise<{text: string; done?: Done}> {
  const s = (k: string) => (typeof call.input[k] === 'string' ? call.input[k] as string : '');
  const n = (k: string) => (typeof call.input[k] === 'number' ? call.input[k] as number : undefined);
  switch (call.name) {
    case 'read': {
      const r = await hands.read(s('path'), n('offset'), n('limit'));
      return {text: r.text, done: {tool: 'read', path: s('path'), ...r}};
    }
    case 'bash': {
      const r = await hands.run(s('command'));
      return {text: `${r.given}\n[exit status ${r.status ?? 'unknown'}]`, done: {tool: 'bash', command: s('command'), ...r}};
    }
    case 'edit': {
      if (!hands.edit) break;
      const edits = Array.isArray(call.input.edits) ? call.input.edits as {oldText: string; newText: string}[] : [];
      const r = await hands.edit(s('path'), edits);
      return {text: `Edited ${s('path')}: ${r.spans.length} piece${r.spans.length === 1 ? '' : 's'} replaced, +${r.added} −${r.removed} lines.`,
        done: {tool: 'edit', path: s('path'), ...r}};
    }
    case 'write': {
      if (!hands.write) break;
      const r = await hands.write(s('path'), s('content'));
      return {text: `${r.before === null ? 'Made' : 'Written'} ${s('path')}: +${r.added} −${r.removed} lines.`,
        done: {tool: 'write', path: s('path'), text: s('content'), ...r}};
    }
  }
  throw new Error(`There is no tool ${call.name} here.`);
}

/** The Agent: asked with `prompt`, it works until the model calls no more tools; each prompt goes on the same talk. */
export class Agent {
  readonly #o: AgentOptions;
  readonly #talk: Talk;
  readonly #listeners = new Set<(e: AgentEvent) => void>();
  readonly tools: ToolName[];

  constructor(o: AgentOptions) {
    this.#o = o;
    this.tools = toolsOf(o.hands);
    this.#talk = o.talk ?? talkTo(o.use, o.system, this.tools.map((t) => TOOLS[t]), o.signal);
  }

  /** Hear what it does; returns how to stop hearing. A listener that throws is let go of, not the work. */
  subscribe(fn: (e: AgentEvent) => void): () => void { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }

  #say(e: AgentEvent) {
    for (const fn of [...this.#listeners]) {
      try { fn(e); } catch { this.#listeners.delete(fn); }
    }
  }

  /** `question` worked on; its last words (what it says it did). Throws what stopped it, having said so. */
  async prompt(question: string): Promise<string> {
    const {hands, before, after, signal} = this.#o;
    this.#say({type: 'agent_start', question});
    this.#talk.said(question);
    let last = '';
    try {
      for (let k = 0; k < TURNS; k++) {
        this.#say({type: 'turn_start'});
        const turn = await this.#talk.ask();
        if (turn.text.trim()) { last = turn.text; this.#say({type: 'message_end', text: turn.text}); }
        if (!turn.calls.length) {
          this.#say({type: 'turn_end'});
          this.#say({type: 'agent_end', said: last});
          return last;
        }
        // One after another, as a person would: a write, then the tests that read it.
        const results: Given[] = [];
        for (const call of turn.calls) {
          signal?.throwIfAborted();
          this.#say({type: 'tool_execution_start', id: call.id, name: call.name, args: call.input});
          let r: {text: string; done?: Done};
          const refused = await before?.(call);
          if (typeof refused === 'string') r = {text: refused};
          else {
            try { r = await done(call, hands); } catch (e) { r = {text: e instanceof Error ? e.message : String(e)}; }
          }
          let given: Given = {call, text: r.text, error: !r.done};
          const instead = await after?.(call, given);
          if (typeof instead === 'string') given = {...given, text: instead};
          this.#say({type: 'tool_execution_end', id: call.id, name: call.name, args: call.input, result: given.text, isError: given.error, ...(r.done ? {done: r.done} : {})});
          results.push(given);
        }
        this.#talk.answered(results);
        this.#say({type: 'turn_end'});
      }
      throw new AgentError(0, `stopped after ${TURNS} turns without finishing`);
    } catch (e) {
      const error = e instanceof AgentError ? e : new AgentError(0, e instanceof Error ? e.message : String(e));
      this.#say({type: 'agent_end', said: last, error});
      throw error;
    }
  }
}
