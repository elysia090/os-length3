// The floors, natively and translated on this machine, side by side:
//
//   node tests/floors/floors.ts [os|code] [N]     os: the OS's primitives (os.c); code: translated code (code.c)
//
// Each is built static (musl-gcc, its relocations kept, as sods needs) and run three ways: natively; translated,
// each thread in a Worker of its own (as a cross-origin isolated page runs them); and translated, every thread in
// this one (SODS_INLINE=1, as a page that is not runs them). N runs only the Nth floor. A floor beside Linux is its
// ratio, translated over native: under 1, it is lower than Linux's.
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const kinds = process.argv[2] === 'code' ? ['code'] : process.argv[2] === 'os' ? ['os'] : ['os', 'code'];
const only = process.argv[3] ? [process.argv[3]] : [];
const dir = mkdtempSync(join(tmpdir(), 'muk-floors-'));

/** "name   12.34 us" lines as [name, value]. */
const read = (out: string): [string, number][] =>
  out.trim().split('\n').map((l) => /^(.*?)\s+([\d.]+) (?:us|ns)$/.exec(l)).filter((m) => !!m).map((m) => [m[1], Number(m[2])]);

try {
  for (const kind of kinds) {
    const exe = join(dir, kind);
    execFileSync('musl-gcc', ['-static', '-O2', '-pthread', '-Wl,--emit-relocs', join(here, `${kind}.c`), '-o', exe]);
    const run = (env: Record<string, string>, ...cmd: string[]) =>
      read(execFileSync(cmd[0], [...cmd.slice(1), ...only], {encoding: 'utf8', env: {...process.env, ...env}, maxBuffer: 1 << 24}));
    const native = run({}, exe);
    const apart = run({}, process.execPath, join(here, '..', '..', 'runtime', 'run.ts'), exe);
    const inline = run({SODS_INLINE: '1'}, process.execPath, join(here, '..', '..', 'runtime', 'run.ts'), exe);
    const unit = kind === 'os' ? 'us' : 'ns';
    console.log(`${kind === 'os' ? 'the OS' : 'translated code'} (${unit} a time)`.padEnd(28) + 'Linux'.padStart(12) + 'Workers'.padStart(12) + 'in turn'.padStart(12) + '   ×Linux');
    native.forEach(([name, n], k) => {
      const a = apart[k]?.[1] ?? NaN, i = inline[k]?.[1] ?? NaN;
      console.log(name.padEnd(28) + n.toFixed(2).padStart(12) + a.toFixed(2).padStart(12) + i.toFixed(2).padStart(12) + `   ${(a / n).toFixed(1)} / ${(i / n).toFixed(1)}`);
    });
    console.log();
  }
} finally {
  rmSync(dir, {recursive: true, force: true});
}
