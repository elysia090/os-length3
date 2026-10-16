import type {PurposeId} from '../purposes.ts';

/** What a page may ask of the shell. */
export interface Context {
  go(id: PurposeId): void;
  /** Open a repo in Forge, at `path` inside it if given. */
  openRepo(name: string, path?: string): void;
  /** Record the repo Forge shows, without leaving or redrawing the page. */
  remember(name: string): void;
  /** The repo Forge shows, if any. */
  readonly repo: string | null;
  rerender(): void;
}
