import {t} from '../../i18n/i18n.ts';
import {base64, inPieces, onChange, store, unbase64, walkRepo} from '../../repos/repos.ts';

// The repo in a browser's Prompt is the repo (terminal.ts): copied in for the shell as it starts, what the shell
// changes under /root/<repo> written back through the store, and what is saved elsewhere (Forge, Git, root3 on the host…
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

/** A batch as it is written: the folders made, the files put, the paths removed. */
interface Batch { dirs: string[]; files: {path: string; bytes: Uint8Array}[]; removed: string[] }

/** `b` written to the repo `repo` as `by`, in its order; each path that could not be is pushed to `skipped`. */
async function writeBatch(repo: string, by: string, b: Batch, skipped: string[]) {
  for (const d of b.dirs) await store.mkdir(repo, d, by).catch(() => skipped.push(`${d}/`));
  for (const f of b.files) await store.put(repo, f.path, f.bytes, by).catch(() => skipped.push(f.path));
  for (const r of b.removed) await store.remove(repo, r, by).catch(() => skipped.push(r));
}

// Each batch is kept in this tab's storage as it comes (a synchronous write) until the store has it: a page reloaded
// while the store still writes (a trip to the core for each file, a batch of many some seconds) loses none of it,
// and the next start writes what is left (writeLeftBack) before anything is shown. sessionStorage, as a reload keeps
// it and another tab never reads it (that tab's batches, older, would be written over newer). A batch past JOURNAL
// bytes is not kept so: the tab's storage holds a few megabytes.
const JOURNAL = 1 << 20, KEPT = 'root3.os.writeback.';
interface Kept { repo: string; by: string; dirs: string[]; files: {path: string; b64: string}[]; removed: string[] }
let batches = 0;
/** `b` kept under a key that sorts in the order it came; null when it is not kept (too large, or no storage). */
function keep(repo: string, by: string, b: Batch): string | null {
  if (b.files.reduce((n, f) => n + f.bytes.length, 0) > JOURNAL) return null;
  const key = `${KEPT}${Date.now().toString().padStart(15, '0')}.${String(batches++).padStart(6, '0')}`;
  const kept: Kept = {repo, by, dirs: b.dirs, files: b.files.map((f) => ({path: f.path, b64: base64(f.bytes)})), removed: b.removed};
  try { sessionStorage.setItem(key, JSON.stringify(kept)); return key; } catch { return null; }
}
const unkeep = (key: string | null) => { if (key) try { sessionStorage.removeItem(key); } catch { /* gone with the tab */ } };

/** What a page reloaded before the store had all of its shell's changes left kept: written now, in the order it came. */
export async function writeLeftBack(): Promise<void> {
  let keys: string[];
  try { keys = Object.keys(sessionStorage).filter((k) => k.startsWith(KEPT)).sort(); } catch { return; }
  for (const key of keys) {
    try {
      const kept = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Kept | null;
      if (kept) await writeBatch(kept.repo, kept.by, {...kept, files: kept.files.map((f) => ({path: f.path, bytes: unbase64(f.b64)}))}, []);
    } catch { /* a batch not kept whole is not written */ }
    unkeep(key);
  }
}

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
    const repo = this.#repo, by = this.#by, skipped: string[] = [];
    // Any file, text or not, as the app's Prompt writes the repo itself; one past the budget is said, not written.
    const files = c.files.filter((f) => {
      if (this.#budget.files <= 0 || this.#budget.bytes < f.bytes.length) return !skipped.push(f.path);
      this.#budget.files--;
      this.#budget.bytes -= f.bytes.length;
      return true;
    });
    const batch = {dirs: c.dirs, files, removed: c.removed}, key = keep(repo, by, batch);
    this.#queue = this.#queue.then(async () => {
      await writeBatch(repo, by, batch, skipped);
      unkeep(key);
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
