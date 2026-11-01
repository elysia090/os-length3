// The repos' Prompts this window has started (terminal.ts makes them), as what only asks after them sees them: Home's
// rows and gear, the reference, Me, Runtime. Apart from the terminal itself, so a page that only asks does not bring
// the Prompt's whole screen (and l3's machine) with it.

import type {Session} from './terminal.ts';

/** Each repo's session, by its name. */
export const sessions = new Map<string, Session>();

/** Every session started in this window, running or stopped. */
export const allSessions = (): [string, Session][] => [...sessions];

/** The repo's session if one is running, without starting one. */
export const sessionIfAny = (repo: string): Session | undefined => sessions.get(repo);

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
