// The migrations in two stages around a deploy (deploy.ts). A deploy
// migrates before it ships the Worker, so the Worker still running meets
// every migration first: one that drops what it reads would break it until
// the new one is out. Such a step is a contract step, tagged
// `NNNN_contract_…` (drizzle-kit generate --name contract_…): the migrations
// before the first contract step not applied yet run before the Worker, and
// that step and every one after it run once the new Worker answers. So the
// Worker that stops reading a column ships with the expand step, and the
// column goes after it. (dev.ts and the tests apply every one at once.)

import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

interface Journal { entries: {idx: number; when: number; tag: string}[] }

const CONTRACT = /^\d{4}_contract_/;

/** How many of the journal's first entries run before the Worker, the newest applied being at `applied` (0: none). */
export function beforeWorker(j: Journal, applied: number): number {
  const cut = j.entries.findIndex((e) => e.when > applied && CONTRACT.test(e.tag));
  return cut < 0 ? j.entries.length : cut;
}

export const journalOf = (folder: string): Journal => JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as Journal;

/** A folder of the first `n` migrations of `folder`, as drizzle's migrator reads one (the caller removes it). */
export function firstOf(folder: string, n: number): string {
  const j = journalOf(folder);
  const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  mkdirSync(join(dir, 'meta'));
  const entries = j.entries.slice(0, n);
  for (const e of entries) copyFileSync(join(folder, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({...j, entries}));
  return dir;
}
