// What sods is to make run, and how far each is (#191). A program is written for one instruction set (its input) and
// lands on a machine of one (where it runs), on a host that is a system, a browser, or nothing at all. Every
// combination is here, each in one of four states, so that "not made yet", "made and not checked" and "cannot be"
// are never read as one another, and no one above sods (muk, prompt, ricebox, a product) decides anything by where
// a program runs: they ask here.
//
//   verified       it runs there, and a check that runs it there is named (a file of this repository)
//   unverified     what is made should run there, and no check runs it there yet
//   unimplemented  part of what sods is for, not made yet: what it needs is named
//   excluded       cannot hold on that platform: the reason is named, and it is not work left to do
//
// Today there is one route: a static x86-64 Linux program made WebAssembly ahead of its run (src/), which a
// WebAssembly engine then runs on whatever machine it is on, the Linux it asks for answered by linux/ and the host
// by host.ts (a browser's page, one of its Workers, node). So an x86-64 input reaches every machine an engine does,
// and no other input reaches any yet. The order things are made in is not the goal made smaller: all nine pairs of
// instruction sets are the goal.
//
//   node module/sods/runtime/targets.ts      the table, as README.md has it (a test holds the two the same)
//
// And below it, what stands between today and one implementation of each thing on every host.

/** An instruction set: a program's (its input), or a machine's (where it runs). */
export type Isa = 'x86-64' | 'arm64' | 'riscv64';
/** Where it runs: a host system, a browser's page, a Worker, or no system at all. */
export type Where = 'linux' | 'macos' | 'windows' | 'browser' | 'worker' | 'bare';

export const ISAS: readonly Isa[] = ['x86-64', 'arm64', 'riscv64'];
export const WHERES: readonly Where[] = ['linux', 'macos', 'windows', 'browser', 'worker', 'bare'];

export type State =
  | {is: 'verified'; by: string}
  | {is: 'unverified'; why: string}
  | {is: 'unimplemented'; needs: string}
  | {is: 'excluded'; why: string};

/** The checks that run translated programs: a file each, of this repository. */
const NODE = 'module/sods/test/programs/run.sh', PAGE = 'tests/app/linux.spec.ts';

/** How far a program for `input` is from running on a machine of `runs`, on `where`. */
export function target(input: Isa, runs: Isa, where: Where): State {
  // What no work changes comes first: it is not owed.
  if (runs === 'riscv64' && where === 'macos') return {is: 'excluded', why: 'macOS runs on no RISC-V machine'};
  if (runs === 'riscv64' && where === 'windows') return {is: 'excluded', why: 'Windows is released for no RISC-V machine'};
  if (input !== 'x86-64') return {is: 'unimplemented', needs: `a translator for ${input} programs: src/ reads x86-64 (elf.rs refuses another machine's)`};
  if (where === 'bare') return {is: 'unimplemented', needs: 'a host with no system under it: host.ts answers for a page, a Worker and node'};
  const engine = where === 'browser' || where === 'worker' ? 'a browser' : 'node';
  if (runs !== 'x86-64') return {is: 'unverified', why: `the same WebAssembly under ${engine} there; no check runs on ${runs}`};
  if (where === 'linux') return {is: 'verified', by: NODE};
  if (where === 'browser' || where === 'worker') return {is: 'verified', by: PAGE};
  return {is: 'unverified', why: `the same WebAssembly under node there (host.ts asks node, not the system); no check runs on ${where}`};
}

/** Every combination with its state: 54 rows, input first. */
export function targets(): {input: Isa; runs: Isa; where: Where; state: State}[] {
  return ISAS.flatMap((input) => ISAS.flatMap((runs) => WHERES.map((where) => ({input, runs, where, state: target(input, runs, where)}))));
}

// ---- One implementation each.
//
// muk is the C that makes a box and prompt the Rust at a terminal's other end, on every host: where there is no
// Linux under them, the Linux they ask for is answered here, and nothing is written a second time for a host. What
// stands between today and that is below, each with what it needs: the calls muk makes that this Linux does not
// answer (CALLS_OWED: none now; a test reads muk's sources and this kernel's tables, so a call muk comes to make
// that is not answered is added), and where a box or a terminal is still made by something else (BRANCHES).

/** A call muk makes that sods' Linux has no answer for (`absent`), or answers by refusing (`refused`: what with, and when). None is: each is answered as Linux answers it (linux/sys-mount.ts, linux/sys-proc.ts), and muk's own corpus runs with muk on this Linux (test/muk/run.sh). */
export interface CallOwed { nr: number; name: string; how: 'absent' | 'refused'; needs: string }
export const CALLS_OWED: readonly CallOwed[] = [];

/** Where a box or a terminal is made by something that is not muk or prompt: what does it today, and what ends that. */
export interface Branch { what: string; by: string; needs: string }
export const BRANCHES: readonly Branch[] = [
  {what: 'a box where there is no Linux (a page, a Worker, node)', by: 'the caller starts its program directly on this Linux (linux.ts linux(): why/app/host/prompt/kernel.worker.ts, scripts/webroot-runnable.ts)',
    needs: 'the caller writes a bundle and starts `muk run` of it here, as module/sods/test/muk/run.sh does with muk\'s own corpus (muk.sh, hostile.sh), which passes with muk on this Linux'},
  {what: 'a box on the desktop (Linux)', by: "why's core makes it itself (why/core/src/prompt/launch.rs, seccomp.rs; why/core/src/compute)",
    needs: 'the launcher runs `muk run` on a bundle it writes, and its own making of a box goes'},
  {what: 'a terminal where there is no Linux', by: "the page's own console (why/app/host/prompt/kernel.worker.ts, why/app/prompt)",
    needs: 'signalfd answered here, and the terminal muk gives away (made here: linux/pty.ts) taken by `prompt attach` on this Linux, checked by module/prompt/test/prompt.sh there'},
  {what: 'a terminal on the desktop (Linux)', by: "why's core's session (why/core/src/prompt)", needs: 'the session hands the descriptor muk sends to `prompt attach`'},
];

/** Everything owed before nothing is: each row that is not verified or excluded, each call, each branch. */
export function owed(): string[] {
  return [
    ...targets().filter(({state}) => state.is === 'unverified' || state.is === 'unimplemented')
      .map(({input, runs, where, state}) => `${input} on ${runs}, ${where}: ${said(state)}`),
    ...CALLS_OWED.map((c) => `muk asks ${c.name} (${c.nr}), ${c.how} here: ${c.needs}`),
    ...BRANCHES.map((b) => `${b.what} is made by ${b.by}: ${b.needs}`),
  ];
}

/** The calls owed (where any is) and the branches as README.md has them. */
export function owedTable(): string {
  const calls = CALLS_OWED.length ? ['| Call muk makes | Here | What it needs |', '| --- | --- | --- |', ...CALLS_OWED.map((c) => `| ${c.name} (${c.nr}) | ${c.how} | ${c.needs} |`), ''] : [];
  return [...calls, '| What is made | By, today | What ends that |', '| --- | --- | --- |',
    ...BRANCHES.map((b) => `| ${b.what} | ${b.by} | ${b.needs} |`)].join('\n');
}

const said = (s: State): string => s.is === 'verified' ? `verified: \`${s.by}\`` : s.is === 'unimplemented' ? `unimplemented: ${s.needs}` : `${s.is}: ${s.why}`;

/** The table as README.md has it: a row for each input and machine, the hosts that share a state said together. */
export function table(): string {
  const lines = ['| Input | Runs on | Where | State |', '| --- | --- | --- | --- |'];
  for (const input of ISAS) for (const runs of ISAS) {
    const groups = new Map<string, Where[]>();
    for (const where of WHERES) { const s = said(target(input, runs, where)); groups.set(s, [...groups.get(s) ?? [], where]); }
    for (const [state, wheres] of groups) lines.push(`| ${input} | ${runs} | ${wheres.join(', ')} | ${state} |`);
  }
  return lines.join('\n');
}

// node targets.ts          the table of what runs where
// node targets.ts --one    the calls owed and the branches
// node targets.ts --owed   everything owed, a line each; it ends 1 while anything is (what a release that may owe
//                          nothing is held to: scripts/release.sh, for ricebox's own line)
if (typeof process !== 'undefined' && process.argv[1]?.endsWith('/targets.ts')) {
  if (process.argv.includes('--owed')) {
    const list = owed();
    for (const line of list) console.log(line);
    if (list.length) { console.error(`sods: ${list.length} owed: nothing is released on these terms until none is`); process.exit(1); }
  } else console.log(process.argv.includes('--one') ? owedTable() : table());
}
