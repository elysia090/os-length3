import {core, isNative} from '../app/host.ts';
import {every} from '../app/runs.ts';

// What agents (Claude Code, Grok Build, a harness that runs their hooks) do in this device's repos, as their own hooks
// say it (core/src/agents.rs), and the work handed to one (core/src/tasks.rs): what it can take, asks, has ready to
// look at. Read every second while a page that shows it is on screen and the window is: the core answers nothing from
// two files' sizes while nothing moved, so a second's look costs nothing. Only on a device: a browser runs no agent.

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

/** Something the agent found, at a unit: the goal, a part of the system, the tests, a file. */
export interface Finding {unit: 'goal' | 'responsibility' | 'test' | 'file' | 'question'; path?: string; line?: number; text: string}

/** Work handed to the agent, or offered to it (core/src/tasks.rs Task). */
export interface Task {
  id: number;
  repo: string;
  line: string;
  issue?: string;
  deed: 'take' | 'review' | 'tests' | 'fix' | 'ask';
  words: string;
  state: 'offered' | 'waiting' | 'working' | 'asking' | 'ready' | 'stopped';
  found?: Finding[];
  questions?: string[];
  said?: string;
  fix?: string;
  updated: number;
}

interface Now {journal: {events: AgentEvent[]; sessions: AgentSession[]; cursor: unknown} | null; tasks: {mark: unknown; agent: string | null; list: Task[]} | null}

let sessions: AgentSession[] = [];
let cursor: unknown = null;
let tasks: Task[] = [];
let agent: string | null = null;
let mark: unknown = null;
const hearers = new Map<(events: AgentEvent[]) => void, () => boolean>();
let looking: {stop(): void} | null = null;

/** The work handed to the agent or offered to it, not over, oldest first. */
export const tasksNow = (): readonly Task[] => tasks;
/** The agent work is handed to (claude, grok…), if one is set up. */
export const agentNow = () => agent;

/** A deed on a task: hand it over, put it away, answer it. What is so then comes with the next look. */
export async function onTask(id: number, deed: 'take' | 'drop' | 'reply', words = '') {
  await core('task', {id, deed, words});
  await look();
}

/** A question about `repo`, answered by the agent reading only; the answer comes as a task ready. */
export async function askAgent(repo: string, words: string) {
  await core('task', {deed: 'ask', repo, words});
  await look();
}

/** Every agent's session now (and those ended a moment ago), newest first. */
export const agentsNow = (): readonly AgentSession[] => sessions;

/** The sessions at work on `line` of `repo` (not ended). */
export const agentsOn = (repo: string, line: string) => sessions.filter((s) => s.repo === repo && s.line === line && s.state !== 'ended');

/** The line an issue is worked on: its file's stem (core/src/work.rs line_for). */
export const lineOf = (issueFile: string) => issueFile.replace(/^issue\//, '').replace(/\.md$/, '');

/** A harness as a person knows it. */
export const harnessName = (h: string) => ({claude: 'Claude Code', grok: 'Grok Build', dsh: 'DeepSeek Harness', codex: 'Codex'})[h] ?? h;

async function look() {
  const now = await core<Now | null>('agents', {...(cursor === null ? {} : {cursor}), ...(mark === null ? {} : {tasks: mark})});
  if (!now) return;
  if (now.journal) { cursor = now.journal.cursor; sessions = now.journal.sessions; }
  if (now.tasks) { mark = now.tasks.mark; tasks = now.tasks.list; agent = now.tasks.agent; }
  const events = now.journal?.events ?? [];
  for (const [f, alive] of [...hearers]) if (alive()) f(events); else hearers.delete(f);
}

/**
 * `f` told what came each time something did (with what is so then in agentsNow), for as long as `alive` holds
 * (its element on screen); the journal is read while anyone listens, and told once at once of what is so.
 */
export function onAgents(f: (events: AgentEvent[]) => void, alive: () => boolean): void {
  if (!isNative) return;
  hearers.set(f, alive);
  if (sessions.length || tasks.length) queueMicrotask(() => { if (alive()) f([]); });
  if (looking) return;
  void look().catch(() => { /* the next look says it */ });
  looking = every(1000, look, {alive: () => {
    for (const [g, ok] of [...hearers]) if (!ok()) hearers.delete(g);
    if (hearers.size) return true;
    looking = null;
    return false;
  }});
}
