import type {PurposeId} from '../purposes.ts';

/** What a page may ask of the shell. */
export interface Context {
  go(id: PurposeId): void;
  /** Open a repo in Forge, at `path` inside it if given; with `write`, the caret goes to that file's start. */
  openRepo(name: string, path?: string, write?: boolean): void;
  /** The file Forge's center is reading now (null for none), for File to mark. */
  reading(path: string | null): void;
  /** Record the repo Forge shows, without leaving or redrawing the page. */
  remember(name: string): void;
  /** The repo Forge shows, if any. */
  readonly repo: string | null;
  rerender(): void;
}
