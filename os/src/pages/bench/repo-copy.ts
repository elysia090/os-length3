import {t} from '../../i18n.ts';
import {inPieces, onChange, store, walkRepo} from '../../repos/repos.ts';

// The repo in a browser's Prompt is the repo (terminal.ts): copied in for the shell as it starts, what the shell
// changes under /root/<repo> written back through the store, and what is saved elsewhere (Forge, Git, l3 on the host…
// through the store) put into the shell's copy. Binary files and files over the read limit stay where they are.

const LIMIT_FILES = 2000;
const LIMIT_BYTES = 32 << 20;

/**
 * Copy a repo's files for the guest: [{path, bytes}] under /root/<repo>. The repo is listed a level at a time and
 * its files (in the walk's order, up to the limits) read at once a few megabytes at a time: a repo of hundreds
 * of files is a few trips to the core, not one a file.
 */
export async function snapshot(repo: string) {
  const dirs: string[] = [`/root/${repo}`];
  const wanted: {path: string; size: number}[] = [];
  let total = 0, complete = true;
  for (const {path, entry: e} of await walkRepo(repo)) {
    if (e.kind === 'dir') { dirs.push(`/root/${repo}/${path}`); continue; }
    if (e.kind !== 'file') continue;
    if (wanted.length >= LIMIT_FILES || total + e.size > LIMIT_BYTES) { complete = false; continue; }
    total += e.size;
    wanted.push({path, size: e.size});
  }
  const read = await inPieces(wanted, (f) => f.size, (f) => store.bytes(repo, f.path).catch(() => null));
  const files: {path: string; bytes: Uint8Array}[] = [];
  wanted.forEach((f, k) => { const bytes = read[k]; if (bytes) files.push({path: `/root/${repo}/${f.path}`, bytes}); else complete = false; });
  return {files, dirs, complete};
}

/** What the shell changed in its copy, as its Worker says it. */
interface Changes { dirs: string[]; files: {path: string; bytes: Uint8Array; existed: boolean}[]; removed: string[] }

/** The shell's changes written back to the repo `repo` as `by`, in order; `skipped` hears what could not be. */
export class WriteBack {
  readonly #repo: string;
  readonly #by: string;
  readonly #skipped: (said: string) => void;
  #queue: Promise<void> = Promise.resolve();
  /** What the shell may still write back, in files and bytes: the snapshot's limits. */
  #budget = {files: LIMIT_FILES, bytes: LIMIT_BYTES};

  constructor(repo: string, by: string, skipped: (said: string) => void) {
    this.#repo = repo;
    this.#by = by;
    this.#skipped = skipped;
  }

  /** Write the shell's changes back to the repo, in order, one batch after another. */
  write(c: Changes) {
    const repo = this.#repo, by = this.#by;
    this.#queue = this.#queue.then(async () => {
      const skipped: string[] = [];
      for (const d of c.dirs) await store.mkdir(repo, d, by).catch(() => skipped.push(`${d}/`));
      for (const f of c.files) {
        // Any file, text or not, as the app's Prompt writes the repo itself.
        if (this.#budget.files <= 0 || this.#budget.bytes < f.bytes.length) { skipped.push(f.path); continue; }
        this.#budget.files--;
        this.#budget.bytes -= f.bytes.length;
        await store.put(repo, f.path, f.bytes, by).catch(() => skipped.push(f.path));
      }
      for (const r of c.removed) await store.remove(repo, r, by).catch(() => skipped.push(r));
      if (skipped.length) this.#skipped(t('Failed to sync back to repo: {list}', {list: `${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ' …' : ''}`}));
    });
  }
}

/** A file or directory saved in the shell's copy (`what`: its bytes, 'dir', or null for gone). */
interface Put { type: 'put'; path: string; what: Uint8Array | 'dir' | null }

/** What is saved elsewhere in `repo` (not by `by`, the shell) comes into its copy through `put`; returns how to stop. */
export function mirror(repo: string, by: string, put: (message: Put) => void): () => void {
  return onChange((c) => {
    if (c.repo !== repo || c.by === by || c.what === 'repo') return;
    const what = c.what === 'file' ? new TextEncoder().encode(c.text ?? '') : c.what === 'dir' ? 'dir' : null;
    put({type: 'put', path: c.path, what});
  });
}
