import {onRenamed, rekey} from '../../repos/repos.ts';

// What was asked of the box's Agent in each repo while the app runs, and what came of it, as it comes: the question,
// then what it did and said in the order it did and said it (a step as the pane's flow says it: read, ran, edited;
// its words as it wrote them), refused and why, and whether it is still at work. Under the search box, Agent's list
// and one of them read whole (reference.ts), as Output's are of what was run (agent.ts writes it).

/** One of what an ask comes to, in order: a step it took, or its words. */
export type AskPart = {kind: 'step'; text: string} | {kind: 'words'; text: string};

export interface Ask {
  question: string;
  /** When it was asked, in ms since 1970: no two of a repo's alike (what tells one from another). */
  started: number;
  parts: AskPart[];
  /** Why nothing more came, refused or failed; '' while it did not. */
  refused: string;
  done: boolean;
}

/** Kept per repo, at most: past it, the oldest go. */
const KEPT = 50;
const asks = new Map<string, Ask[]>();
onRenamed((from, to) => rekey(asks, from, to));
const watchers = new Set<(repo: string) => void>();
let last = 0;

/** What was asked of the Agent in `repo`, oldest first. */
export const asksIn = (repo: string): Ask[] => asks.get(repo) ?? [];

/** Hear when an ask in a repo begins or goes on; returns how to stop. */
export function watchAsks(fn: (repo: string) => void): () => void { watchers.add(fn); return () => watchers.delete(fn); }

/** Something of an ask in `repo` came (or it began, or ended): those who watch hear it. */
export function askChanged(repo: string) { for (const fn of [...watchers]) fn(repo); }

/** `question` asked of the Agent in `repo`, at the end of its list: what comes of it is added to what is returned. */
export function asked(repo: string, question: string): Ask {
  last = Math.max(Date.now(), last + 1);
  const a: Ask = {question, started: last, parts: [], refused: '', done: false};
  asks.set(repo, [...asksIn(repo), a].slice(-KEPT));
  askChanged(repo);
  return a;
}
