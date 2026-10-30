// Whether the stylesheet as it is now is the same stylesheet as it was (after styles-split.mjs, say):
//
//   node scripts/styles-check.mjs [--before REV|FILE] [SHEET]
//
// BEFORE is a file, or a git revision whose SHEET it reads (HEAD unless named; an entry there is read with its parts
// at that revision). Two things are held side by side, and both must be the same:
//   - what the two say, in order: each comment and each rule, in the @media (and so on) it stands in, whatever the
//     room between them and wherever a part file starts or ends (and whether, read one after another without the
//     comment each part starts with, they are even the same text);
//   - the CSS Vite builds from each (as the app's build does: its minifier, its targets), byte for byte; or, where
//     the bytes differ, what that CSS says, rule by rule in order.
// It says which, and exits 1 when they are not the same.

import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {build} from 'vite';
import {said, wholeSheet} from './styles-split.mjs';
import {entryOf} from './styles-sheet.mjs';

const OS = fileURLToPath(new URL('..', import.meta.url));

/** The sheet and the files it imports, as {path (from the sheet's folder): text}: from disk, or from git at `rev`. */
function filesOf(sheet, rev) {
  const read = rev ? (p) => git(['show', `${rev}:${gitPath(p)}`]) : (p) => readFileSync(p, 'utf8');
  const entry = read(sheet);
  const out = {[relative(dirname(sheet), sheet)]: entry};
  for (const p of entryOf(entry)?.files ?? []) out[p.replace(/^\.\//, '')] = read(resolve(dirname(sheet), p));
  return out;
}

const git = (args) => execFileSync('git', args, {cwd: OS, encoding: 'utf8', maxBuffer: 64 << 20});
const gitPath = (p) => relative(git(['rev-parse', '--show-toplevel']).trim(), p);

/** The files written in a folder of their own, with what is in it read as one sheet. */
function laidOut(files, name) {
  const dir = mkdtempSync(join(tmpdir(), `styles-check-${name}-`));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), {recursive: true});
    writeFileSync(join(dir, p), text);
  }
  return dir;
}

/** The CSS Vite builds from the sheet at `dir/<sheet>`, linked from a page as index.html links the app's. */
async function built(dir, sheet) {
  writeFileSync(join(dir, 'index.html'), `<!doctype html>\n<link rel="stylesheet" href="/${sheet}">\n`);
  const out = await build({configFile: false, root: dir, logLevel: 'silent', build: {target: 'es2022', write: false, emptyOutDir: false}});
  const assets = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output).filter((a) => a.fileName.endsWith('.css'));
  if (assets.length !== 1) throw new Error(`the build made ${assets.length} stylesheets, not one`);
  return String(assets[0].source);
}

async function main() {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {before: {type: 'string'}}});
  const sheet = resolve(positionals[0] ?? join(OS, 'src', 'styles.css'));
  const before = values.before ?? 'HEAD';
  const old = existsSync(before) ? filesOf(resolve(before), null) : filesOf(sheet, before);
  const now = filesOf(sheet, null);
  const name = (files) => Object.keys(files)[0];
  const dirs = [laidOut(old, 'before'), laidOut(now, 'now')];
  let same = true;
  try {
    const [p, q] = [wholeSheet(join(dirs[0], name(old))), wholeSheet(join(dirs[1], name(now)))];
    const a = said(p), b = said(q);
    const at = a.findIndex((x, i) => x !== b[i]);
    if (at < 0 && a.length === b.length) console.log(`said: the same ${a.length} comments and rules in the same order${p === q ? ', read one after another the same text byte for byte' : ''}`);
    else {
      same = false;
      console.log(`said: they part at the ${at < 0 ? a.length : at}th thing said:\n  before: ${a[at] ?? '(nothing)'}\n  now:    ${b[at] ?? '(nothing)'}`);
    }
    const [x, y] = [await built(dirs[0], name(old)), await built(dirs[1], name(now))];
    if (x === y) console.log(`built: the same ${x.length} bytes of CSS`);
    else {
      const p = said(x), q = said(y);
      const k = p.findIndex((v, i) => v !== q[i]);
      if (k < 0 && p.length === q.length) console.log(`built: ${x.length} and ${y.length} bytes, the same ${p.length} rules in the same order`);
      else { same = false; console.log(`built: the CSS differs at its ${k < 0 ? p.length : k}th rule:\n  before: ${p[k]}\n  now:    ${q[k]}`); }
    }
  } finally {
    for (const d of dirs) rmSync(d, {recursive: true, force: true});
  }
  if (!same) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
