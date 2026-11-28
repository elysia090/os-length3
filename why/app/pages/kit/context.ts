import type {PlaceCommand} from './places.ts';
import type {PurposeId} from '../../host/purposes.ts';
import type {ForgePlace, SearchDesk} from './places.ts';
import type {Carry} from '../../ui/glide.ts';

/**
 * Where the caret goes in a file opened to write in: its start (true), its end, back at `at` (an offset kept when it
 * was left), its saved selection (resume), its name (a file just made), or not in it (false). A Search match keeps
 * the editor's own selection and marks those words at the given line.
 */
export type Writing = boolean | 'end' | 'name' | 'resume' | {at: number} | {match: string};

/** What a page may ask of the shell. */
export interface Context extends SearchDesk {
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
  /** Present the existing File tree inside Forge without a modal veil; null puts that pane away. */
  forgeFiles?(repo: string | null, focus?: boolean, index?: boolean): void;
  /** Go through the shell's Forge route, with the named place in hand when its repo is ready. */
  placeCommands?(omit: readonly PurposeId[]): readonly PlaceCommand[];
  forgePlace?(place: ForgePlace): Promise<void>;
  /** The shell's existing places and tools not already offered on this desk. */
  /** The file last read in Forge, kept from one visit to the next: where the person left off. */
  readonly leftOff: {repo: string; path: string; at: number | null; time?: number} | null;
  rerender(): void;
}
