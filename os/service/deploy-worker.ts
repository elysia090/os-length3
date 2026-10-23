import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

/** Code and secrets in one version. Wrangler opens a regular JSON file, not a pipe via /dev/stdin. */
export async function deployWorker(give: Record<string, string>, run: (args: string[]) => Promise<void>): Promise<void> {
  if (!Object.keys(give).length) { await run(['deploy']); return; }
  // Outside the source/build tree, so the secrets cannot become a served asset or a committed file.
  const dir = mkdtempSync(join(tmpdir(), 'length3-secrets-'));
  try {
    chmodSync(dir, 0o700);
    const file = join(dir, 'secrets.json');
    writeFileSync(file, JSON.stringify(give), {flag: 'wx', mode: 0o600});
    await run(['deploy', '--secrets-file', file]);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}
