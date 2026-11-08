import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from './fixtures.ts';
import {OS} from './paths.ts';

// The Prompt in a browser is Linux to what runs in it (issue #80, its runtime requirements and what it is accepted
// by): files, their modes and links; files and folders kept across a reload (a mode and a link not yet: muk's); the
// shell's own features; the standard streams, a pipeline's statuses and the statuses and signals Linux says; jobs;
// text past ASCII; the terminal; a POSIX script, and scripts that ship in the root; the editor and the shell in step;
// a C program built and its test run. Each line is run as a person runs it and what it prints read as Linux prints
// it (the same lines, run on Linux, say the same). What the Prompt's keys do (Ctrl+C, Ctrl+D, Ctrl+Z, ↑, →), its
// colours and the programs that draw on a screen are prompt.spec.ts's. Slow (the root through the translator): @slow,
// run with SELFTEST_SLOW=1, as CI does.

const PROMPT = join(OS, 'public', 'l3', 'l3.json');
test.use({storageState: async ({helloC}, use) => { await use(helloC); }});

test.describe('the Prompt is Linux', {tag: '@slow'}, () => {
  test.skip(!process.env.SELFTEST_SLOW, '@slow: SELFTEST_SLOW=1 runs it');
  test.beforeEach(async ({app}) => {
    expect(existsSync(PROMPT), 'this build carries no l3 (public/l3): npm run l3, or node scripts/prompt-files.ts').toBe(true);
    test.setTimeout(300_000);
    await app.newRepo.openInForge();
    await app.forge.startPrompt('hello');
  });

  /** `line` run, and each of `lines` then among what it printed, as a line of its own. */
  const says = async (app: Parameters<Parameters<typeof test>[2]>[0]['app'], line: string, ...lines: (string | RegExp)[]) => {
    await app.forge.run(line);
    for (const l of lines) await expect(app.forge.prompt).toContainText(typeof l === 'string' ? new RegExp(`^${l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm') : l, {timeout: 120_000});
  };

  test('a file runs once it may: Permission denied before chmod +x; a link reads through, a hard link counts two, a mode stays as chmod set it', async ({app}) => {
    await says(app, `printf '#!/bin/sh\\necho ran\\n' > s.sh; ./s.sh; echo "st=$?"`, 'st=126', /Permission denied/);
    await expect(app.forge.prompt).not.toContainText('bad interpreter');
    await says(app, "chmod +x s.sh; ./s.sh; chmod 640 s.sh; stat -c 'mode=%a' s.sh; ln -sf s.sh link; readlink link; ln -f s.sh hard; stat -c 'links=%h' s.sh",
      'ran', 'mode=640', 's.sh', 'links=2');
  });

  test('the streams apart and joined, a here string, a descriptor of its own, and the statuses and signals Linux says', async ({app}) => {
    await says(app, 'ls nosuch 2>/dev/null; echo "st=$?"; { echo a; echo b >&2; } 2>e.txt >o.txt; cat o.txt e.txt; echo hi | tee t.txt | tr a-z A-Z; cat /dev/stdin <<< here-string; exec 3>fd3.txt; echo three >&3; exec 3>&-; cat fd3.txt; false | true; echo "pipe=${PIPESTATUS[*]}"',
      'st=1', 'a', 'b', 'HI', 'here-string', 'three', 'pipe=1 0');
    await says(app, `(exit 7); echo "a=$?"; nosuch-cmd; echo "b=$?"; sh -c 'kill -TERM $$'; echo "c=$?"; sh -c 'kill -9 $$'; echo "d=$?"; echo "e=$(sh -c 'kill -INT $$'; echo $?)"; trap 'echo got USR1' USR1; kill -USR1 $$; trap - USR1`,
      'a=7', /nosuch-cmd: command not found/, 'b=127', 'c=143', 'd=137', 'e=130', 'got USR1');
  });

  test('jobs in the background are listed, killed by their number and waited for; text past ASCII is characters; the terminal is one', async ({app}) => {
    await says(app, 'sleep 30 & sleep 31 &', /^\[2\] \d+$/m);
    await says(app, 'jobs', /^\[1\]- +Running +sleep 30 &$/m, /^\[2\]\+ +Running +sleep 31 &$/m);
    await says(app, 'kill %1 %2; wait; echo jobs-done', /^\[1\]- +Terminated +sleep 30$/m, 'jobs-done');
    await says(app, 'echo 日本語 | wc -m; touch 日本.txt; ls 日本.txt; printf "%s\\n" é | wc -c; tty; stty size; [ -t 0 ] && echo in-tty; [ -t 1 ] && echo out-tty',
      '4', '日本.txt', '3', '/dev/pts/0', /^\d+ \d+$/m, 'in-tty', 'out-tty');
  });

  test('the shell\'s own: the environment, a local variable, arithmetic, parameter expansion, globs, if and until, && and ||, a subshell, a here document', async ({app}) => {
    await says(app, [
      'export E1=env-ok; sh -c \'echo "env=$E1"\'',
      'g() { local v=in; echo "local=$v"; }; v=out; g; echo "v=$v"',
      'echo "arith=$(( (3 + 4) * 5 % 6 ))"',
      'p=/a/b/c.tar.gz; echo "${p##*/} ${p%.*} ${p#/a/} ${#p} ${u:-dflt} ${p/b/B}"',
      'mkdir -p gl && touch gl/a1 gl/a2 gl/b1; echo gl/a*',
      'if [ -d gl ]; then echo if-yes; else echo if-no; fi; i=0; until [ $i -ge 3 ]; do i=$((i + 1)); done; echo "until=$i"',
      'false || echo or-ok; true && echo and-ok; (cd gl && echo "sub=${PWD##*/}"); echo "after=${PWD##*/}"',
      'cat <<END', 'here $E1', 'END',
    ].join('\n'), 'env=env-ok', 'local=in', 'v=out', 'arith=5', 'c.tar.gz /a/b/c.tar b/c.tar.gz 13 dflt /a/B/c.tar.gz', 'gl/a1 gl/a2',
    'if-yes', 'until=3', 'or-ok', 'and-ok', 'sub=gl', 'after=hello', 'here env-ok');
  });

  test('a POSIX script runs as sh and as bash run it: functions, case, getopts, set -e, a trap on EXIT, a loop reading lines, a command substituted', async ({app}) => {
    const script = [
      '#!/bin/sh', 'set -e', 'trap "echo bye" EXIT',
      'f() { case $1 in a*) echo "A:$1";; *) echo "other:$1";; esac; }',
      'while getopts xy: o; do case $o in x) echo X;; y) echo "Y=$OPTARG";; esac; done', 'shift $((OPTIND-1))',
      'for w in "$@"; do f "$w"; done',
      'printf "%%s\\\\n" one two | while read -r l; do echo "read $l"; done',
      'n=$(echo 3 4 | awk "{print \\\\$1*\\\\$2}"); echo "n=$n"', '[ "$n" -eq 12 ] && echo twelve', 'false', 'echo never',
    ].join('\\n');
    await says(app, `printf '${script}\\n' > p.sh; sh p.sh -x -y val apple pear; echo "sh=$?"`,
      'X', 'Y=val', 'A:apple', 'other:pear', 'read one', 'read two', 'n=12', 'twelve', 'bye', 'sh=1');
    await expect(app.forge.prompt).not.toContainText(/^never$/m);
    await says(app, 'bash p.sh -x pear; echo "bash=$?"', 'other:pear', 'bye', 'bash=1');
  });

  test('scripts as their makers wrote them run: gzip\'s zgrep and zdiff, xz\'s xzgrep', async ({app}) => {
    await says(app, "printf 'alpha\\nbeta\\ngamma\\n' > w.txt; gzip -k w.txt; xz -k w.txt; zgrep -n beta w.txt.gz; echo \"xz=$(xzgrep -c a w.txt.xz)\"; { cat w.txt; echo delta; } | gzip > v.txt.gz; zdiff w.txt.gz v.txt.gz; echo \"zdiff=$?\"",
      '2:beta', 'xz=3', '@@ -1,3 +1,4 @@', '+delta', 'zdiff=1');
  });

  test('the editor and the shell are one repo: a file saved in Forge is the shell\'s, what the shell writes is the editor\'s and the tree\'s', async ({app}) => {
    await app.forge.editFile('README.md', 'from-forge\n');
    // What the editor saves comes into the shell's copy by itself, a moment after: read when it has.
    await says(app, 'for i in $(seq 100); do grep -qx from-forge README.md && break; sleep 0.1; done; cat README.md', 'from-forge');
    await says(app, 'echo from-shell >> README.md; echo made-here > sync.txt; echo written', 'written');
    await expect(app.forge.editor('README.md')).toHaveValue('from-forge\nfrom-shell\n', {timeout: 30_000});
    await app.file.open('hello', 'sync.txt');
    await expect(app.forge.editor('sync.txt')).toHaveValue('made-here\n', {timeout: 30_000});
  });

  test('a C program is built and run, by cc and by make, and its test is run: a check passing, an assert that fails said', async ({app}) => {
    await says(app, 'cc -o t src/main.c && ./t; echo "cc=$?"', 'cc=0');
    await says(app, 'make >/dev/null && ./build/hello; echo "make=$?"', 'make=0');
    await says(app, "printf '#include <assert.h>\\n#include <stdlib.h>\\nint main(int c, char **v) { assert(c < 2 || atoi(v[1]) == 2); return 0; }\\n' > u.c; printf 'check: u\\n\\t./u 2\\n' > check.mk; make -f check.mk check >/dev/null; echo \"check=$?\"; ./u 3 2>/dev/null; echo \"failed=$?\"",
      'check=0', 'failed=134');
  });

  test('files and folders written are kept across a reload at once, every one of a batch', async ({app}) => {
    // Reloaded as soon as the line is done (its prompt line back), no later: what it wrote is in the store by then, or in
    // the journal written back at the next start.
    await says(app, 'echo kept > keep.txt; mkdir -p d/e && echo deep > d/e/f; for i in 1 2 3 4 5 6; do echo "n$i" > "m$i.txt"; done; echo written',
      'written');
    await expect(app.page.locator('.desk-box[data-key="term"] .prompt-ps')).toHaveText(/hello \$/);
    await app.page.reload();
    await app.newRepo.openInForge();
    await app.forge.startPrompt('hello');
    await says(app, 'cat keep.txt d/e/f; echo $(cat m*.txt)', 'kept', 'deep', 'n1 n2 n3 n4 n5 n6');
  });

  test('a link and a file that runs are kept across a reload as they were (not yet: the store keeps contents only, muk keeps modes and links, step 6)', async ({app}) => {
    test.fail();
    await says(app, "printf '#!/bin/sh\\necho ran\\n' > s.sh; chmod +x s.sh; ln -sf s.sh link; echo written", 'written');
    await app.page.reload();
    await app.newRepo.openInForge();
    await app.forge.startPrompt('hello');
    await says(app, "stat -c 'mode=%a' s.sh; readlink link || echo no-link; echo checked", 'checked');
    for (const l of [/^mode=755$/m, /^s\.sh$/m]) await expect(app.forge.prompt).toContainText(l, {timeout: 1000});
  });
});
