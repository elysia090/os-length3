import {core, isNative} from '../app/host.ts';
import {every} from '../app/runs.ts';

// What agents (Claude Code, Grok Build, a harness that runs their hooks) do in this device's repos, as their own hooks
// say it: each calls `l3 agent hook` on what it does, and the core keeps it (core/src/agents.rs). Read every second
// while a page that shows it is on screen and the window is: the core answers from a file's size and first line while
// nothing came, so a second's look costs nothing. Only on a device: a browser runs no agent's harness.

export interface AgentSession {
  harness: string;
  session: string;
  repo: string;
  /** The line it works on: an issue's (its file's stem), or main. */
  line: string;
  started: number;
  last: number;
  /** working: doing something; waits: for the person (a permission, an answer, its turn over); ended. */
  state: 'working' | 'waits' | 'ended';
  /** What it does or did last (a tool and what on), or was asked. */
  doing: string;
}

export interface AgentEvent {
  at: number;
  harness: string;
  session: string;
  repo: string;
  line: string;
  kind: 'start' | 'prompt' | 'tool' | 'tool-done' | 'waits' | 'stop' | 'end';
  text?: string;
}

interface Now {events: AgentEvent[]; sessions: AgentSession[]; cursor: unknown}

let sessions: AgentSession[] = [];
let cursor: unknown = null;
const hearers = new Map<(events: AgentEvent[]) => void, () => boolean>();
let looking: {stop(): void} | null = null;

/** Every agent's session now (and those ended a moment ago), newest first. */
export const agentsNow = (): readonly AgentSession[] => sessions;

/** The sessions at work on `line` of `repo` (not ended). */
export const agentsOn = (repo: string, line: string) => sessions.filter((s) => s.repo === repo && s.line === line && s.state !== 'ended');

/** The line an issue is worked on: its file's stem (core/src/work.rs line_for). */
export const lineOf = (issueFile: string) => issueFile.replace(/^issue\//, '').replace(/\.md$/, '');

/** A harness as a person knows it. */
export const harnessName = (h: string) => ({claude: 'Claude Code', grok: 'Grok Build', dsh: 'DeepSeek Harness', codex: 'Codex'})[h] ?? h;

async function look() {
  const now = await core<Now | null>('agents', cursor === null ? {} : {cursor});
  if (!now) return;
  cursor = now.cursor;
  sessions = now.sessions;
  for (const [f, alive] of [...hearers]) if (alive()) f(now.events); else hearers.delete(f);
}

/**
 * `f` told what came each time something did (with what is so then in agentsNow), for as long as `alive` holds
 * (its element on screen); the journal is read while anyone listens, and told once at once of what is so.
 */
export function onAgents(f: (events: AgentEvent[]) => void, alive: () => boolean): void {
  if (!isNative) return;
  hearers.set(f, alive);
  if (sessions.length) queueMicrotask(() => { if (alive()) f([]); });
  if (looking) return;
  void look().catch(() => { /* the next look says it */ });
  looking = every(1000, look, {alive: () => {
    for (const [g, ok] of [...hearers]) if (!ok()) hearers.delete(g);
    if (hearers.size) return true;
    looking = null;
    return false;
  }});
}
