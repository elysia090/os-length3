// you/unicode.h, the Unicode that you's regular expressions know (you/regex.c), taken from ripgrep's own
// answers so that what `you rg` finds is what `rg` finds: the characters past ASCII that \w, \d and \s take, and which
// characters are one when case is aside (each character's next in its circle of case: K → k → K (Kelvin) → K).
// ripgrep is run in a root (bwrap: its own /, as commands.ts runs it) over every character, one a line.
//
//   node scripts/you-unicode.ts ROOT_DIR
//
// Each table is a string of numbers, seven bits a byte (the high bit: more follows). Ranges: the gap from the end of
// the one before (from 0x7f), then the length less one. Circles: runs of characters, each its gap from the last of
// the run before (from -1), its count less one (counted by its step), and its kind: the distance to the next as zigzag,
// times 4, plus 0 (each character) or 1 (every other); or 2, pairs 2k ↔ 2k+1, or 3, pairs 2k+1 ↔ 2k+2.
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = process.argv[2];
if (!root) throw new Error('usage: node scripts/you-unicode.ts ROOT_DIR');
const out = fileURLToPath(new URL('../../you/unicode.h', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'you-unicode-'));

/** What a command of ripgrep's says, run in the root with `work` at /tmp/w. */
function rg(args: string[]): Buffer {
  const r = spawnSync('bwrap', ['--unshare-all', '--ro-bind', root, '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--bind', work, '/tmp/w', ...args], {maxBuffer: 1 << 28});
  if (r.status !== 0 && r.status !== 1) throw new Error(`rg ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}
const chars = (b: Buffer) => [...new Set(b.toString('utf8').split('\n').filter(Boolean).map((c) => c.codePointAt(0)!))].sort((a, b) => a - b);

try {
  const all: string[] = [];
  for (let c = 0x80; c < 0x110000; c++) if (c < 0xd800 || c > 0xdfff) all.push(String.fromCodePoint(c));
  writeFileSync(join(work, 'all'), all.join('\n') + '\n');
  const rgo = (pattern: string, file: string) => rg(['/usr/bin/rg', '-o', '--no-line-number', '--no-filename', '-e', pattern, file]);

  const ranges = (cs: number[]) => {
    const rs: [number, number][] = [];
    for (const c of cs) if (rs.length && rs.at(-1)![1] + 1 === c) rs.at(-1)![1] = c; else rs.push([c, c]);
    return rs;
  };
  const varint = (v: number, o: number[]) => { for (; v >= 0x80; v >>>= 7) o.push((v & 0x7f) | 0x80); o.push(v); };
  const table = (rs: [number, number][]) => {
    const o: number[] = [];
    let prev = 0x7f;
    for (const [lo, hi] of rs) varint(lo - prev - 1, o), varint(hi - lo, o), prev = hi;
    return o;
  };

  // Case: each character that has a case is asked what `(?i)` of it takes; the circles are what is joined so.
  const cased = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'].map((c) => c.charCodeAt(0));
  cased.push(...chars(rgo('[\\p{Cased}\\p{CWCM}\\p{CWCF}]', '/tmp/w/all')));
  writeFileSync(join(work, 'cased'), cased.map((c) => String.fromCodePoint(c)).join('\n') + '\n');
  writeFileSync(join(work, 'asks'), cased.map((c) => c.toString(16)).join('\n') + '\n');
  writeFileSync(join(work, 'ask.sh'), 'while read h; do printf "%s:" "$h"; /usr/bin/rg -o --no-line-number --no-filename "(?i)\\\\x{$h}" /tmp/w/cased | od -An -tx1 | tr -d "\\n"; echo; done < /tmp/w/asks\n');
  const parent = new Map<number, number>();
  const find = (x: number): number => { while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!; return x; };
  for (const line of rg(['/bin/sh', '/tmp/w/ask.sh']).toString().split('\n').filter(Boolean)) {
    const [h, bytes] = line.split(':');
    const c = parseInt(h, 16);
    for (const d of chars(Buffer.from(bytes.trim().split(/\s+/).filter(Boolean).map((x) => parseInt(x, 16))))) {
      const a = find(c), b = find(d);
      if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
    }
  }
  const circles = new Map<number, number[]>();
  for (const c of parent.keys()) circles.set(find(c), [...(circles.get(find(c)) ?? []), c]);
  const next = new Map<number, number>();
  let longest = 0;
  for (const [r, cs] of circles) {
    const m = [...new Set([r, ...cs])].sort((a, b) => a - b);
    longest = Math.max(longest, m.length);
    m.forEach((c, i) => next.set(c, m[(i + 1) % m.length]));
  }
  const keys = [...next.keys()].sort((a, b) => a - b);
  // Runs: one distance (every character, or every other), or pairs that are each other's (2k ↔ 2k+1, or 2k+1 ↔ 2k+2).
  const evenOdd = (c: number) => next.get(c) === (c ^ 1), oddEven = (c: number) => next.get(c) === (c & 1 ? c + 1 : c - 1);
  const runs: {start: number; last: number; kind: number; delta: number}[] = [];
  for (const c of keys) {
    const delta = next.get(c)! - c, r = runs.at(-1);
    const fits = r && (r.kind === 0 ? c === r.last + 1 && delta === r.delta
      : r.kind === 1 ? c === r.last + 2 && delta === r.delta
      : r.kind === 2 ? c === r.last + 1 && evenOdd(c)
      : r.kind === 3 ? c === r.last + 1 && oddEven(c)
      : c === r.last + 1 && delta === r.delta ? (r.kind = 0, true)
      : c === r.last + 2 && delta === r.delta ? (r.kind = 1, true)
      : c === r.last + 1 && evenOdd(r.start) && evenOdd(c) ? (r.kind = 2, true)
      : c === r.last + 1 && oddEven(r.start) && oddEven(c) ? (r.kind = 3, true) : false);
    if (fits) r.last = c;
    else runs.push({start: c, last: c, kind: -1, delta});
  }
  const fold: number[] = [];
  let prev = -1;
  for (const r of runs) {
    const kind = r.kind < 0 ? 0 : r.kind, step = kind === 1 ? 2 : 1;
    varint(r.start - prev - 1, fold), varint((r.last - r.start) / step, fold);
    varint(((kind >= 2 ? 0 : r.delta < 0 ? -r.delta * 2 - 1 : r.delta * 2) << 2) | kind, fold);
    prev = r.last;
  }

  const bytes = (name: string, o: number[], what: string) => `/* ${what} */\nstatic const u8 ${name}[${o.length}] = {${o.map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(',').replace(/((?:0x..,){24})/g, '$1\n  ')}};\n`;
  const w = table(ranges(chars(rgo('\\w', '/tmp/w/all'))));
  const d = table(ranges(chars(rgo('\\d', '/tmp/w/all'))));
  const s = table(ranges(chars(rgo('\\s', '/tmp/w/all'))));
  const version = rg(['/usr/bin/rg', '--version']).toString().split('\n')[0];
  writeFileSync(out, `/*
 * The Unicode that regex.c knows past ASCII, as ${version} has it: made by os/scripts/you-unicode.ts, which asks
 * ripgrep itself (not edited by hand). Numbers seven bits a byte, the high bit saying more follows.
 *
 * U_WORD, U_DIGIT, U_SPACE: what \\w, \\d and \\s take past ASCII, as ranges: each the gap from the end of the one before
 * (from 0x7f), then its length less one. U_FOLD: each character's next in its circle of case (at most U_FOLD_ROUND
 * long), as runs: the gap from the run before's last (from -1), the count less one (by its step), and its kind: the
 * distance to the next as zigzag times 4, plus 0 (each character) or 1 (every other); or 2, pairs 2k ↔ 2k+1, or 3,
 * pairs 2k+1 ↔ 2k+2.
 */
#define U_FOLD_ROUND ${longest}
${bytes('U_WORD', w, '\\w')}${bytes('U_DIGIT', d, '\\d')}${bytes('U_SPACE', s, '\\s')}${bytes('U_FOLD', fold, 'circles of case')}`);
  console.log(`unicode.h: \\w ${w.length} B, \\d ${d.length} B, \\s ${s.length} B, case ${fold.length} B (${runs.length} runs, circles up to ${longest})`);
} finally {
  rmSync(work, {recursive: true, force: true});
}
