// A folder of a run's own under the system's temporary directory, which a run
// does not leave behind for long however it ends. Each one says which
// process made it (.owner), and making one first takes away those of the same
// kind whose process is gone: a run that passed and removed its own leaves
// nothing, and one that was killed (a time limit, Ctrl-C twice) before it
// could leaves its folder only until the next run of its kind. Folders that
// say no owner are not this helper's, and are left as they are.
//
// For what tests and their servers make: scripts/tests.ts, selftest's
// global setup and selftest/l3. Rust's tests do the same by their process's
// own folder (core/src/testing.rs, l3/tests/common).

import {mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** Whether process `pid` is there (one of another user's, which may not be signalled, is). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** A new folder named `prefix` and six random letters, owned by this process; those of `prefix` whose owner is gone, taken away first. */
export function scratch(prefix: string): string {
  const tmp = tmpdir();
  for (const name of readdirSync(tmp)) {
    if (!name.startsWith(prefix)) continue;
    const at = join(tmp, name);
    let owner = 0;
    try { owner = Number(readFileSync(join(at, '.owner'), 'utf8')); } catch { continue; }
    if (owner && owner !== process.pid && !alive(owner)) rmSync(at, {recursive: true, force: true});
  }
  const dir = mkdtempSync(join(tmp, prefix));
  writeFileSync(join(dir, '.owner'), String(process.pid));
  return dir;
}
