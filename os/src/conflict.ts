// One file open in Forge against what the store holds for it. A text saved
// elsewhere (another device, through the Remote; the Prompt; Git) comes in
// at once while nothing here is unsaved. While something here is unsaved,
// it is asked, never decided: saving waits until the person takes the other
// text or saves theirs over it, and what differs can be seen meanwhile.

import {hunks, lineOps, type DiffLine} from './linediff.ts';

export type Came = 'same' | 'take' | 'ask';

export class Held {
  /** What the store holds as far as this editor knows (what it last read or wrote). */
  saved: string;
  /** The text saved elsewhere while this one had unsaved edits; null when nothing is asked. */
  theirs: string | null = null;

  constructor(saved: string) { this.saved = saved; }

  get asking() { return this.theirs !== null; }

  /**
   * A text saved elsewhere came, with `mine` in the editor: 'same' when it is
   * what is here already, 'take' when nothing here is unsaved (show it),
   * 'ask' when something is (and keep asking with the newest of theirs).
   */
  came(text: string, mine: string): Came {
    if (text === mine) { this.saved = text; this.theirs = null; return 'same'; }
    if (mine === this.saved && !this.asking) { this.saved = text; return 'take'; }
    this.theirs = text;
    return 'ask';
  }

  /** Whether saving may go on its own: never while it is asked. */
  get canSave() { return !this.asking; }

  /** The person wrote on while it is asked: true when theirs and mine became the same, which ends the ask. */
  typed(mine: string): boolean {
    if (this.theirs === null || this.theirs !== mine) return false;
    this.saved = mine;
    this.theirs = null;
    return true;
  }

  /** Take the other text: it is what the editor shows, and nothing is written. */
  useTheirs(): string {
    const text = this.theirs ?? this.saved;
    this.saved = text;
    this.theirs = null;
    return text;
  }

  /** Save mine over theirs: what to write. Once written, `wrote` says so. */
  keepMine(mine: string): string {
    this.theirs = null;
    return mine;
  }

  wrote(text: string) { this.saved = text; }
}

/** What saving here would do to the other text: theirs before, mine after, as a diff shows a change. */
export function differs(theirs: string, mine: string): {lines: DiffLine[]; more: number; added: number; removed: number} {
  const ops = lineOps(theirs, mine);
  return {...hunks(ops), added: ops.filter((o) => o.kind === 'add').length, removed: ops.filter((o) => o.kind === 'del').length};
}
