// The repos' Prompts this window has started (terminal.ts makes them), as what only asks after them sees them: Home's
// rows and gear, the reference, Me, Runtime. Apart from the terminal itself, so a page that only asks does not bring
// the Prompt's whole screen (and why's machine) with it.

import type {Stopped} from '../../../api/host.ts';
import {t} from '../../../text/i18n.ts';

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
  readonly begun: boolean;
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

/** Fixed positions on Forge's Prompt rail, not names or identities of worker processes. */
export const TERMINAL_SIDES = ['left', 'right'] as const;
export type TerminalSide = typeof TERMINAL_SIDES[number];
const sessions = new Map<string, Map<TerminalSide, Prompt>>();

/** Every user's session in this window, including ones becoming ready or ending. */
export const allSessions = (): [string, Prompt][] => [...sessions].flatMap(([repo, bySide]) =>
  [...bySide.values()].map((prompt): [string, Prompt] => [repo, prompt]));

/** The left Prompt is the one other work pages have always shown. */
export const sessionIfAny = (repo: string, side: TerminalSide = 'left'): Prompt | undefined => sessions.get(repo)?.get(side);

export function keepPrompt(repo: string, side: TerminalSide, prompt: Prompt) {
  let bySide = sessions.get(repo);
  if (!bySide) sessions.set(repo, bySide = new Map());
  bySide.set(side, prompt);
}

/** Never remove a successor in the same slot on account of its predecessor. */
export function forgetPrompt(repo: string, side: TerminalSide, prompt: Prompt): boolean {
  const bySide = sessions.get(repo);
  if (!bySide || bySide.get(side) !== prompt) return false;
  bySide.delete(side);
  if (!bySide.size) sessions.delete(repo);
  return true;
}

const active = (s: Prompt) => s.running || (s.begun && !s.ended) || !!s.stopped?.left;
const incomplete = () => new Error(t('The Prompt has processes remaining'));

/** Any busy side holds a repo; a pill can instead ask only about its own side. */
export function promptHolds(repo: string, side?: TerminalSide): 'busy' | 'idle' | null {
  const bySide = sessions.get(repo);
  if (!bySide) return null;
  let waiting = false;
  for (const [there, s] of bySide) {
    if ((side && there !== side) || !active(s)) continue;
    if (s.stopped?.left || !s.running || s.runs.at(-1)?.ms === null) return 'busy';
    waiting = true;
  }
  return waiting ? 'idle' : null;
}

/** A repo-wide deed stops every side, including a side that is still being started. */
export async function stopPrompt(repo: string, gone = false) {
  const held = [...sessions.get(repo) ?? []];
  const stopped = await Promise.allSettled(held.filter(([, s]) => active(s)).map(async ([, s]) => { await s.stop(); }));
  const failure = stopped.find((r) => r.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  if (held.some(([, s]) => s.stopped?.left) || promptHolds(repo)) throw incomplete();
  if (gone) for (const [side, prompt] of held) forgetPrompt(repo, side, prompt);
}
