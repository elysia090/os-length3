import type {PurposeId} from '../purposes.ts';
import type {Writing} from './reader.ts';

/** What a page may ask of the shell. */
export interface Context {
  /** Go to `id`: settles once its page is drawn (a page may pan in a frame later). */
  go(id: PurposeId): Promise<void>;
  /** Open a repo in Forge, at `path` inside it if given (at `line` of it); with `write`, the caret goes into that file (reader.ts). */
  openRepo(name: string, path?: string, write?: Writing, from?: Element, line?: number): void;
  /** The file Forge's center is reading now (null for none), for File to mark. */
  reading(path: string | null): void;
  /** Where in `path` of `repo` Forge is read or written (an offset), kept as where the person left off. */
  leftAt(repo: string, path: string, at: number): void;
  /** File's tree out, with the menu of `path` in `repo` ('' for the repo itself): New file, New folder, Rename, Delete as it allows. */
  actOn(repo: string, path: string): void;
  /** Record the repo Forge shows, without leaving or redrawing the page. */
  remember(name: string): void;
  /** The repo Forge shows, if any. */
  readonly repo: string | null;
  /** The file last read in Forge, kept from one visit to the next: where the person left off. */
  readonly leftOff: {repo: string; path: string; at: number | null} | null;
  rerender(): void;
}
