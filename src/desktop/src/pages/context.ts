import type {PurposeId} from '../purposes.ts';

/** What a page may ask of the shell. */
export interface Context {
  go(id: PurposeId): void;
  /** Open a repo in File. */
  openRepo(name: string): void;
  /** The repo File shows, if any. */
  readonly repo: string | null;
  rerender(): void;
}
