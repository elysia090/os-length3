// What of the OS's look a person may change, as everyday reads it off the stylesheets: written into the app
// (why/app/ui/look-things.ts), which holds a person's changes to it without reading the sheets as it runs.
//
//   node scripts/look.ts            write the table
//   node scripts/look.ts --check    say whether the table is the one the sheets give (and end 1 if it is not)
//
// A token added, taken away or changed without this run again fails look.test.ts.
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {things, type Thing} from '../module/everyday/src/everyday.ts';

const OS = fileURLToPath(new URL('..', import.meta.url));
const STYLES = join(OS, 'why', 'app', 'styles');
const TABLE = join(OS, 'why', 'app', 'ui', 'look-things.ts');

/** Every sheet of the app's, read as one: what one sets twice, or by the window, is seen to be so. */
export const sheets = () => readdirSync(STYLES).filter((f) => f.endsWith('.css')).sort().map((f) => readFileSync(join(STYLES, f), 'utf8')).join('\n');

/** The table as it is written: each thing's name, kind, usual value and bounds (what is said of it stays in the sheet). */
export function table(all: Thing[]): string {
  const row = (t: Thing) => `  {name: ${JSON.stringify(t.name)}, kind: ${JSON.stringify(t.kind)}, usual: ${JSON.stringify(t.usual)}, least: ${t.least}, most: ${t.most}, says: ''},`;
  return `// What of the OS's look a person may change: read off the stylesheets by everyday (module/everyday), written here by
// scripts/look.ts and checked against the sheets by look.test.ts. Not written by hand.
import type {Thing} from '../../../module/everyday/src/everyday.ts';

export const THINGS: readonly Thing[] = [
${all.map(row).join('\n')}
];
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const made = table(things(sheets()));
  if (process.argv.includes('--check')) {
    if (readFileSync(TABLE, 'utf8') !== made) { console.error('why/app/ui/look-things.ts is not what the sheets give: node scripts/look.ts'); process.exit(1); }
  } else writeFileSync(TABLE, made);
}
