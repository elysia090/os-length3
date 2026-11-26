/** A page's open contents can be saved, and frozen until a path operation ends. */
interface MoveDraft {
  readonly clean: boolean;
  flush(): Promise<boolean>;
  lock(): (() => void) | null;
}

const within = (path: string, root: string) => path === root || path.startsWith(root + '/');
const overlaps = (a: string, b: string) => within(a, b) || within(b, a);

/** Failed preflight is not a partially successful move. */
export class DraftMoveError extends Error {
  readonly path: string;
  constructor(path: string) { super('Save the open draft before moving its file.'); this.path = path; }
}

interface Moving {
  from: string; to: string;
  held: Map<MoveDraft, () => void>;
}

/** One registry covers file-tree rename/drag, Forge deeds, and the paper's own rename. */
export class OpenDrafts {
  readonly #repo = new Map<string, Map<string, MoveDraft>>();
  readonly #moving = new Map<string, Set<Moving>>();

  #hold(move: Moving, draft: MoveDraft, path: string) {
    if (move.held.has(draft)) return;
    const release = draft.lock();
    if (!release) throw new DraftMoveError(path);
    move.held.set(draft, release);
  }

  register(repo: string, path: string, draft: MoveDraft): () => void {
    let paths = this.#repo.get(repo);
    if (!paths) { paths = new Map(); this.#repo.set(repo, paths); }
    for (const moving of this.#moving.get(repo) ?? []) if (within(path, moving.from) || within(path, moving.to)) this.#hold(moving, draft, path);
    paths.set(path, draft);
    return () => {
      if (paths.get(path) === draft) paths.delete(path);
      if (!paths.size) this.#repo.delete(repo);
    };
  }

  async move(repo: string, from: string, to: string, commit: () => Promise<void>) {
    if (from === to) return;
    let moves = this.#moving.get(repo);
    if (!moves) { moves = new Set(); this.#moving.set(repo, moves); }
    if ([...moves].some((m) => [m.from, m.to].some((p) => overlaps(from, p) || overlaps(to, p)))) throw new DraftMoveError(from);
    const move: Moving = {from, to, held: new Map()};
    moves.add(move);
    try {
      const open = () => [...this.#repo.get(repo) ?? []];
      if (open().some(([path]) => within(path, to) && !within(path, from))) throw new DraftMoveError(to);
      const done = new Set<MoveDraft>();
      // An editor opened during the earlier save is held as soon as it is registered.
      // Flush it as well before starting the irreversible path operation.
      while (true) {
        const next = open().filter(([path, draft]) => within(path, from) && !done.has(draft));
        if (!next.length) break;
        for (const [path, draft] of next) this.#hold(move, draft, path);
        const outcomes = await Promise.all(next.map(async ([path, draft]) => ({path, draft, written: await draft.flush()})));
        for (const {path, draft, written} of outcomes) {
          if (!written || !draft.clean) throw new DraftMoveError(path);
          done.add(draft);
        }
      }
      // Another notice could have made a formerly saved path unsafe while a sibling was saving.
      for (const [path, draft] of open()) if (within(path, from) && !draft.clean) throw new DraftMoveError(path);
      await commit();
    } finally {
      moves.delete(move);
      if (!moves.size) this.#moving.delete(repo);
      for (const release of move.held.values()) release();
    }
  }
}

export const openDrafts = new OpenDrafts();
