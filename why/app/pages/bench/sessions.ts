// The repos' Prompts this window has started (terminal.ts makes them), as what only asks after them sees them: Home's
// rows and gear, the reference, Me, Runtime. Apart from the terminal itself, so a page that only asks does not bring
// the Prompt's whole screen (and why's machine) with it.

import type {Stopped} from '../../host/host.ts';

/** One line sent from the prompt box and what came out until the prompt returned. */
export interface Run {
  line: string; output: string; started: number; ms: number | null;
  /** Its exit status, where the shell says it (the root's shrc: OSC 133 D); null where it does not, or not yet. */
  status?: number | null;
}

/** A repo's Prompt as those who only ask after it see it (terminal.ts's Session is one, and keeps itself here). */
export interface Prompt {
  readonly element: HTMLElement;
  readonly runs: Run[];
  readonly running: boolean;
  /** Where it runs: the root's, or why alone (a browser's, or the app's before the root is here); null before it starts. */
  readonly on: 'root' | 'why' | null;
  /** What its programs hold, in bytes; what it keeps for programs it ran and could let go (a browser's); how many run. */
  readonly memory: number;
  readonly spare: number;
  readonly processes: number;
  /** What letting go of what it kept gave back, until said; null when nothing was let go. */
  readonly freed: number | null;
  readonly stopped: Stopped | null;
  readonly ended: boolean;
  /** Being made ready to start (its root fetched, its copy taken). */
  readonly preparing: boolean;
  /** The prompt line its shell waits at, '' while it does not. */
  readonly promptLine: string;
  /** Hear when it says more or changes; returns how to stop hearing. */
  watch(fn: () => void): () => void;
  /** What ran before goes from its screen (the pane has it). */
  fold(): void;
  /** How long until what it shows now has settled on its screen, in ms. */
  settlesIn(): number;
  /** Let go of what it kept for programs it ran, without stopping it. */
  free(): void;
  stop(): Promise<void>;
  /** A new shell for its repo in its place. */
  restart(): void;
}

/** Each repo's session, by its name. */
export const sessions = new Map<string, Prompt>();

/** Every session started in this window, running or stopped. */
export const allSessions = (): [string, Prompt][] => [...sessions];

/** The repo's session if one is running, without starting one. */
export const sessionIfAny = (repo: string): Prompt | undefined => sessions.get(repo);

/** How the repo's Prompt holds it: 'busy' while a line runs in it, 'idle' while it waits at its prompt line, null when none runs. */
export function promptHolds(repo: string): 'busy' | 'idle' | null {
  const s = sessions.get(repo);
  if (!s?.running) return null;
  return s.runs.at(-1)?.ms === null ? 'busy' : 'idle';
}

/** The repo's Prompt stopped, before its repo goes from here or takes another name; `gone`: let go of, too (its copy is of a repo no longer here). */
export async function stopPrompt(repo: string, gone = false) {
  const s = sessions.get(repo);
  if (s?.running) await s.stop();
  if (gone) sessions.delete(repo);
}
