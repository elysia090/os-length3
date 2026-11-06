import type {PurposeId} from '../../app/purposes.ts';
import type {Carry} from '../../ui/glide.ts';

/**
 * Where the caret goes in a file opened to write in: its start (true), its end, back at `at` (an offset kept when it
 * was left), or not in it (false).
 */
export type Writing = boolean | 'end' | {at: number};

/** What a page may ask of the shell. */
export interface Context {
  /** Go to `id`: settles once its page is drawn (a page may pan in a frame later). */
  go(id: PurposeId): Promise<void>;
  /** Open a repo in Forge, at `path` inside it if given (at `line` of it); with `write`, the caret goes into that file
   * (reader.ts). Grown `from` a thing on the page, its words may be `carried` onto what they become there. */
  openRepo(name: string, path?: string, write?: Writing, from?: Element, line?: number, carried?: Carry): void;
  /** The file Forge's center is reading now (null for none), for File to mark. */
  reading(path: string | null): void;
  /** Where in `path` of `repo` Forge is read or written (an offset), kept as where the person left off. */
  leftAt(repo: string, path: string, at: number): void;
  /** Record the repo Forge shows, without leaving or redrawing the page. */
  remember(name: string): void;
  /** The repo Forge shows, if any. */
  readonly repo: string | null;
  /** The file last read in Forge, kept from one visit to the next: where the person left off. */
  readonly leftOff: {repo: string; path: string; at: number | null} | null;
  rerender(): void;
}
