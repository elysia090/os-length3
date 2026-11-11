// you/ripgrep/types.h, the kinds of file `you rg -t` and `-T` name (you/ripgrep/rg.c), taken from ripgrep's own list so
// that a type means to it what it means to `rg`: each kind's name and the globs a file's name is that kind by.
//
//   node scripts/you-types.ts RG     RG: the root's ripgrep (the one rg.c is checked against, you/ripgrep/rg.sh)
//
// One string: each kind its name, then its globs, each ended by a NUL, the kind ended by one more; the list by a third.
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const rg = process.argv[2];
if (!rg) throw new Error('usage: node scripts/you-types.ts RG');
const out = fileURLToPath(new URL('../module/you/ripgrep/types.h', import.meta.url));
const run = (args: string[]): string => {
  const r = spawnSync(rg, args, {encoding: 'utf8'});
  if (r.status !== 0) throw new Error(`${rg} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const version = run(['--version']).split('\n')[0];
const kinds = run(['--type-list']).trim().split('\n').map((line) => {
  const at = line.indexOf(': ');
  return {name: line.slice(0, at), globs: line.slice(at + 2).split(', ')};
});
// rg.c matches a type's globs with *, ? and [classes] alone, against a file's name (none of ripgrep's holds more).
for (const k of kinds) for (const g of k.globs) if (/[{}/]|\*\*/.test(g)) throw new Error(`${k.name}: ${g} is more than rg.c's type globs take`);
const c = (s: string): string => s.replace(/[\\"]/g, (m) => `\\${m}`);
const lines = kinds.map((k) => `  "${c(k.name)}\\0${k.globs.map((g) => `${c(g)}\\0`).join('')}\\0"`);
writeFileSync(out, `/* you/ripgrep/types.h, made by scripts/you-types.ts from ${version}'s --type-list: the kinds of file -t and -T
 * name (rg.c), each its name and then the globs a file's name is that kind by, each ended by a NUL, the kind by one more. */
static const char TYPES[] =
${lines.join('\n')};
`);
console.log(`${kinds.length} kinds from ${version}`);
