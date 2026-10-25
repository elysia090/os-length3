// npm test: every test file (src/**/*.test.ts, service/*.test.ts, scripts/*.test.mjs) under node:test, each
// process with the core a page runs (src/testing-core.ts), reported as node --test reports.
//
// node --test runs each file in a process of its own: a process paid for starting, loading what its file uses
// and, for a file on a Remote, making a database (some 3 s of CPU before its first test), often more than its
// tests then took. Here there is a process a core, and each takes the next file no other has taken, the longest
// first, and runs it with what the process has made already (service/testing-together.ts), so that they end
// about together; a long file whose tests are each their own (PARTS) is run in parts, several at once. The few
// files that need a process of their own (ALONE) run beside them from the start.
// Each process loads its modules as scripts/tests-load.mjs says: their types stripped and their code compiled
// once for every run, not once a process.
//
// As node --test: NODE_OPTIONS=--test-shard=i/n runs every n-th file from the i-th (CI's four shards), and
// --test-name-pattern, --test-skip-pattern, --test-only, --test-concurrency and --test-reporter are taken.
// Files named run instead of every file (npm test -- service/plan.test.ts src/draft.test.ts).

import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {availableParallelism, tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';
import {run} from 'node:test';
import * as reporters from 'node:test/reporters';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const OS = fileURLToPath(new URL('..', import.meta.url));
/** Where it was run from, which the paths it is given are from. */
const HERE = process.cwd();

/** Files that keep a process of their own, each for what it does to the process, or for its waiting. */
const ALONE = new Set([
  // The Worker as an isolate has it: its app is made once a process, from the first env it is given, and Neon's
  // driver is pointed at this file's bridge. Another file's Worker (service.test.ts's sweep) would meet both.
  'service/worker.test.ts',
  // Transfers over sockets, timed: seconds of waiting for stalls and retries, which would hold up the files after
  // it in a shared process, and an interval of fetch.ts's own.
  'src/fetch.test.ts',
  // Builds l3 with child processes, and waits for them.
  'scripts/l3.test.mjs',
]);

/**
 * Files whose tests are each their own (each makes the Remote or the database it uses, and nothing of the file is
 * kept from one test to the next), which may run in parts in several processes at once (testing-part.ts): one
 * of them, service.test.ts, was a third of all the Remote's tests, and the run waited for it alone at the end.
 */
const PARTS = new Set(['service/service.test.ts', 'service/security.test.ts', 'service/budget.test.ts', 'service/audit.test.ts']);

const {values, positionals} = parseArgs({allowPositionals: true, options: {
  'test-name-pattern': {type: 'string', multiple: true}, 'test-skip-pattern': {type: 'string', multiple: true},
  'test-only': {type: 'boolean'}, 'test-concurrency': {type: 'string'}, 'test-reporter': {type: 'string'}, 'test-shard': {type: 'string'},
}});

/** Each file under `dir` (and its folders, when `deep`) whose name `keep` takes, as a path from os/. */
const under = (dir, keep, deep) => readdirSync(dir, {withFileTypes: true}).flatMap((e) =>
  e.isDirectory() ? (deep ? under(join(dir, e.name), keep, deep) : []) : keep(e.name) ? [join(dir, e.name)] : []);
const named = positionals.map((p) => relative(OS, resolve(HERE, p)));
// Every path from here on is from os/, as the tests expect to be run.
process.chdir(OS);
let files = named.length ? named : [...under('src', (n) => n.endsWith('.test.ts'), true), ...under('service', (n) => n.endsWith('.test.ts')),
  ...under('scripts', (n) => n.endsWith('.test.mjs'))].sort();

// A shard: every n-th file from the i-th, as node --test gives one.
const shard = values['test-shard'] ?? /--test-shard[= ](\S+)/.exec(process.env.NODE_OPTIONS ?? '')?.[1];
if (shard) {
  const [i, n] = shard.split('/').map(Number);
  if (!(n >= 1 && i >= 1 && i <= n)) throw new Error(`--test-shard=${shard}: i/n, from 1/n to n/n`);
  files = files.filter((_, k) => k % n === i - 1);
}

const text = new Map();
const read = (f) => text.get(f) ?? text.set(f, readFileSync(f, 'utf8')).get(f);
/** How long each file took in the runs before on this machine (ms, its tests'), kept in its temporary directory. */
const TOOK = join(tmpdir(), 'length3-test-times.json');
let took = {};
try { took = JSON.parse(readFileSync(TOOK, 'utf8')); } catch { /* the first run here */ }
/**
 * What a file is likely to take, to start the longest first: what it took before, or until it has run here, a
 * guess from its length, with any test file it runs again (contract.nobucket.test.ts), and a few seconds for
 * each database or process it makes of its own.
 */
const guess = (f) => read(f).length / 5 + 3000 * (read(f).match(/new PGlite\(|\bdatabase\(\)|spawnSync\(|execFile\(/g)?.length ?? 0) +
  [...read(f).matchAll(/'\.\/([\w.-]+\.test\.ts)/g)].reduce((n, [, again]) => n + guess(join(dirname(f), again)), 0);
const weight = (f) => took[f] ?? guess(f);

// As node --test, but every core: the runner itself only reports.
const concurrency = Number(values['test-concurrency'] ?? availableParallelism());
const alone = files.filter((f) => ALONE.has(f));
const shared = files.filter((f) => !ALONE.has(f));
// As many processes for them as run at once.
const processes = Math.min(shared.length, concurrency);
// What they run: each file, or a long one of PARTS in parts, none longer than a third of what each process has to
// do, so that the processes end about together.
const most = shared.reduce((n, f) => n + weight(f), 0) / processes / 3;
const units = shared.flatMap((f) => {
  const n = PARTS.has(f) ? Math.min(processes, Math.ceil(weight(f) / most)) : 1;
  return n > 1 ? Array.from({length: n}, (_, k) => `${f}#${k + 1}/${n}`) : [f];
});
const unitWeight = (u) => { const [f, part] = u.split('#'); return weight(f) / (part ? Number(part.split('/')[1]) : 1); };
units.sort((a, b) => unitWeight(b) - unitWeight(a));

// Each one's module, and the folder the files are taken in (a folder each, made once, by whichever process makes
// it first); made for this run, gone when it ends.
const kept = mkdtempSync(join(tmpdir(), 'length3-tests-'));
process.on('exit', () => rmSync(kept, {recursive: true, force: true}));
const together = pathToFileURL(join(OS, 'service/testing-together.ts')).href;
const entries = Array.from({length: processes}, (_, k) => {
  const entry = join(kept, `together-${k + 1}.mjs`);
  writeFileSync(entry, `// One of the processes the test files share in npm test (scripts/tests.mjs).\n` +
    `import {together} from ${JSON.stringify(together)};\nawait together(${JSON.stringify(units)}, ${JSON.stringify(join(kept, 'taken'))});\n`);
  return entry;
});
mkdirSync(join(kept, 'taken'));

const stop = new AbortController();
process.once('SIGINT', () => stop.abort());
// node's own reporters by name (spec on a terminal, tap otherwise, as node --test), or a module's default export.
const name = values['test-reporter'] ?? (process.stdout.isTTY ? 'spec' : 'tap');
const reporter = name === 'spec' ? new reporters.spec() : reporters[name] ?? (await import(pathToFileURL(resolve(HERE, name)).href)).default;
/** What each file took in this run: a shared file's suite (or its parts'), or the sum of a file's own tests. */
const took_ = {};
const timed = (t) => {
  // A part's suite is named by its file and the part (testing-together.ts): what a file took is its parts' together.
  const suite = t.nesting === 0 && t.details?.type === 'suite' ? t.name.replace(/ \[\d+\/\d+\]$/, '') : null;
  const f = shared.includes(suite) ? suite : t.nesting === 0 && t.file && !t.file.startsWith(kept) ? relative(OS, t.file) : null;
  if (f) took_[f] = (took_[f] ?? 0) + Math.round(t.details?.duration_ms ?? 0);
};
run({
  // The files alone first: they wait more than they work, beside the shared processes from the start.
  files: [...alone.map((f) => join(OS, f)), ...entries], concurrency: processes + alone.length, signal: stop.signal,
  // WebAssembly (PGlite's Postgres, the core) as V8 first compiles it, and no further: compiling a hot function
  // again, optimized, took more CPU on other threads than the faster code saved.
  execArgv: ['--liftoff-only', '--import', pathToFileURL(join(OS, 'scripts/tests-load.mjs')).href, '--import', pathToFileURL(join(OS, 'src/testing-core.ts')).href],
  testNamePatterns: values['test-name-pattern'], testSkipPatterns: values['test-skip-pattern'], only: values['test-only'],
})
  .on('test:pass', timed)
  .on('test:fail', (t) => { timed(t); if (!t.todo) process.exitCode = 1; })
  .on('end', () => {
    // Kept for the next run's order (each file that ran whole: not when tests were picked by name).
    if (values['test-name-pattern'] || values['test-skip-pattern'] || values['test-only']) return;
    try { writeFileSync(TOOK, JSON.stringify({...took, ...took_})); } catch { /* the order only */ }
  })
  .compose(reporter)
  .pipe(process.stdout);
