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

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('/targets.ts')) console.log(table());
