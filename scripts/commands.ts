// What a Prompt can do, command by command (issue #80's list, in its kinds): each tried by a line of sh that uses it
// as a person would, run under the browser's kernel (xlat, in node, from the web root) and natively in the same
// root (bwrap), and the two compared. A command is marked by what was seen, never by what is hoped:
//
//   +  runs here: every line that uses it ends as natively, saying the same
//   t  draws on a screen (an editor, a pager, top): runs where the Prompt is a terminal (the app's on the web, one
//      over SSH), not where it shows output alone (TERM=dumb, the desktop app's); `help` says which holds there
//   x  in the root, but some line that uses it does not end as natively under xlat (what differs is said)
//   -  not in the root (and what to reach for instead, where there is something)
//
// The table it writes, module/ricebox/etc/length3/commands, is what `help` shows (otter): one line a command, its name,
// its kind, its mark and what instead, by tabs. The root's builtins of the shell are a kind of their own.
//
//   node scripts/commands.ts WEB ROOT_DIR [--only REGEX] [--jobs N] [--seconds N] [--write | --check]
//
// WEB is the web root (public/webroot), ROOT_DIR the same root unpacked; --write writes the table, --check fails
// when the table kept is not what was seen (CI: so `help` never says more, or less, than is so); without either, the
// lines and what each did are said, and nothing is written.
import {spawn} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {availableParallelism} from 'node:os';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import type {Asked} from './webroot-runnable.ts';
import {openWeb} from './webroot-tree.ts';

const OS = fileURLToPath(new URL('..', import.meta.url));
const ENV = ['HOME=/root', 'PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'LANG=C.UTF-8', 'TERM=xterm-256color', 'USER=root', 'SHELL=/bin/sh'];

/** A kind of command, as #80 names it, and the commands of it, in its order. */
export interface Kind { kind: string; commands: string[] }
/** A line of sh, and the commands it uses (what it says is what they did). */
export interface Line { uses: string[]; line: string }

export const KINDS: Kind[] = [
  {kind: 'core', commands: ['sh', 'bash', 'date', 'seq', 'yes', 'expr', 'bc', 'uname', 'hostname', 'whoami', 'id', 'groups', 'printenv', 'getconf', 'shuf']},
  {kind: 'files', commands: ['ls', 'cat', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch', 'ln', 'readlink', 'stat', 'du', 'df', 'tree', 'find', 'basename',
    'dirname', 'realpath', 'mktemp', 'chmod', 'chown', 'chgrp', 'install', 'truncate', 'sync']},
  {kind: 'text', commands: ['grep', 'sed', 'awk', 'cut', 'tr', 'sort', 'uniq', 'head', 'tail', 'wc', 'xargs', 'tee', 'paste', 'join', 'split', 'diff', 'patch',
    'column', 'nl', 'fold', 'expand', 'unexpand', 'comm', 'fmt', 'tac', 'iconv', 'dos2unix', 'unix2dos']},
  {kind: 'search', commands: ['rg', 'fd', 'fzf', 'which', 'whereis']},
  {kind: 'terminal', commands: ['clear', 'reset', 'tty', 'stty', 'tput', 'watch']},
  {kind: 'inspect', commands: ['file', 'strings', 'xxd', 'od', 'hexdump']},
  {kind: 'checksum', commands: ['md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum', 'b2sum', 'openssl']},
  {kind: 'archives', commands: ['tar', 'gzip', 'gunzip', 'zip', 'unzip', 'bzip2', 'xz', 'zstd']},
  {kind: 'data', commands: ['jq', 'yq', 'base64', 'sqlite3']},
  {kind: 'network', commands: ['curl', 'wget', 'ssh', 'scp', 'sftp', 'nc', 'nslookup', 'ping', 'traceroute', 'dig', 'host', 'ip', 'ss', 'iperf3']},
  {kind: 'editor', commands: ['vi', 'vim', 'nano', 'less', 'more']},
  {kind: 'development', commands: ['git', 'make', 'cmake', 'ninja', 'pkg-config', 'gcc', 'clang', 'cc', 'c++', 'ld', 'ar', 'nm', 'objdump', 'readelf', 'strip',
    'rustc', 'cargo', 'python3', 'pip', 'pip3', 'uv', 'node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'go', 'gofmt']},
  {kind: 'process', commands: ['ps', 'top', 'time', 'timeout', 'env', 'sleep', 'pgrep', 'pkill', 'killall', 'nice', 'renice', 'nohup', 'uptime', 'free', 'lsof',
    'fuser']},
  {kind: 'debug', commands: ['gdb', 'lldb', 'strace', 'ltrace', 'addr2line']},
];

/** The shell's own (ash's builtins), which `type` names as builtins. */
export const BUILTINS = ['alias', 'bg', 'break', 'cd', 'chdir', 'command', 'continue', 'echo', 'eval', 'exec', 'exit', 'export', 'false', 'fg', 'getopts',
  'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local', 'printf', 'pwd', 'read', 'readonly', 'return', 'set', 'shift', 'source', 'test', 'times',
  'trap', 'true', 'type', 'ulimit', 'umask', 'unalias', 'unset', 'wait'];

/** Programs that draw on a screen: they need a terminal, which a Prompt of output alone is not (module/ricebox/etc/length3/shrc). */
const SCREEN = new Set(['vi', 'vim', 'nano', 'less', 'more', 'top', 'watch', 'fzf']);

/** What to reach for instead of a command the root does not have. */
const INSTEAD: Record<string, string> = {
  join: 'awk', column: 'awk', fmt: 'fold', whereis: 'which', b2sum: 'sha512sum', dig: 'nslookup', host: 'nslookup', vim: 'vi nano',
  cmake: 'make', ninja: 'make', clang: 'gcc', 'c++': 'gcc', ltrace: 'strace',
};

/** The lines, each using the commands it names as a person would; a command's lines all end as natively, or it is not marked as running. */
export const LINES: Line[] = [
  // Core
  {uses: ['sh'], line: 'echo $((6*7)) "${0##*/}"; sh -c \'exit 3\'; echo $?'},
  {uses: ['bash'], line: `bash -c 'declare -A m; m[k]=v; a=(1 2 3); echo "\${m[k]} \${#a[@]} \${a[@]:1}"; [[ abc == a* ]] && echo glob; tr a-z A-Z <<< here'`},
  {uses: ['date'], line: 'date -u -d @86400 +%Y-%m-%dT%H:%M:%S; TZ=Asia/Tokyo date -d @0 +%H'},
  {uses: ['seq', 'tr'], line: "seq 3 2 11 | tr '\\n' ' '; seq -w 8 10 | tr '\\n' ' '"},
  {uses: ['yes', 'head'], line: 'yes ab | head -3'},
  {uses: ['expr'], line: "expr 7 \\* 6; expr length hello; expr hello : 'h\\(.*\\)o'"},
  {uses: ['bc'], line: "echo 'scale=5; 4*a(1)' | bc -l; echo '2^100' | bc"},
  {uses: ['uname'], line: 'uname -s -m'},
  {uses: ['hostname'], line: '[ -n "$(hostname)" ] && echo has-name'},
  // (Not `id` bare nor `groups` bare: they say the groups of whoever made the sandbox, which bwrap made by any but root
  // cannot drop and its namespace shows as nobody's; the root's own groups are its /etc/group's.)
  {uses: ['whoami', 'id', 'groups'], line: 'whoami; id -u; id -g; id -un; id -gn; groups root'},
  {uses: ['printenv'], line: 'printenv HOME; FOO=bar printenv FOO'},
  {uses: ['getconf'], line: 'getconf PAGESIZE; getconf PATH_MAX /'},
  {uses: ['shuf', 'sort'], line: "seq 5 | shuf | sort -n | tr '\\n' ' '; shuf -i 1-3 -n 3 | sort | tr '\\n' ' '"},
  // Files
  {uses: ['ls', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch'], line: 'cd /tmp && mkdir -p a/b && touch a/b/f && cp a/b/f a/g && mv a/g a/h && rm a/h && rm a/b/f && rmdir a/b && ls -A a; echo end'},
  {uses: ['ls', 'cat', 'chmod', 'cut'], line: 'cd /tmp && printf 1234 > x && chmod 640 x && ls -l x | cut -c1-10 && cat x; echo; ls -1 / | head -3'},
  {uses: ['ln', 'readlink', 'stat'], line: 'cd /tmp && ln -s target l && readlink l && readlink -f /bin/sh && touch h1 && ln h1 h2 && stat -c %h h1'},
  {uses: ['stat'], line: "cd /tmp && printf abc > s && chmod 600 s && stat -c '%s %a %F' s && stat -c %F /tmp"},
  // Files only: a directory takes a block where its filesystem gives it one (ext4) and none where not (tmpfs).
  {uses: ['du'], line: 'cd /tmp && head -c 100000 /dev/zero > z && head -c 5000 /dev/zero > f && du -k z f | cut -f1; du -ck z f | tail -1 | cut -f1'},
  {uses: ['df'], line: 'df -P / | head -1 | cut -c1-10; df -P /tmp >/dev/null && echo tmp'},
  {uses: ['tree'], line: 'cd /tmp && mkdir -p t/x/y && touch t/x/y/z t/w && tree t'},
  {uses: ['find'], line: "cd /tmp && mkdir -p f/a f/b && touch f/a/1.c f/b/2.h f/b/3.c && find f -name '*.c' | sort; find f -type d | sort | tr '\\n' ' '"},
  {uses: ['basename', 'dirname', 'realpath', 'mktemp'], line: 'basename /a/b.c .c; dirname /a/b.c; cd /tmp && mkdir -p r/s && realpath r/s/../s; t=$(mktemp) && [ -f "$t" ] && echo file; d=$(mktemp -d) && [ -d "$d" ] && echo dir'},
  {uses: ['chmod', 'chown', 'chgrp', 'install', 'truncate', 'sync'], line: 'cd /tmp && touch p && chmod u=rw,g=r,o= p && stat -c %a p && chown 0:0 p && chgrp 0 p && install -m 755 p q && stat -c %a q && truncate -s 100 q && stat -c %s q && sync && echo synced'},
  // Text
  {uses: ['grep', 'sed', 'awk'], line: "printf 'a 1\\nb 2\\nc 3\\n' | grep -v b | sed 's/a/A/' | awk '{s+=$2; t=t $1} END{print s, t}'; grep -E -c '^[a-z]' /etc/passwd"},
  {uses: ['cut', 'tr'], line: "echo a:b:c | cut -d: -f2-; echo hello | tr a-z A-Z; echo 'a  b' | tr -s ' '; echo abc | tr -d b"},
  {uses: ['sort', 'uniq', 'head', 'tail', 'wc'], line: "printf '3\\n1\\n2\\n1\\n10\\n' | sort -n | uniq -c | head -3 | tail -1; printf 'b\\na\\n' | sort -r; printf 'x y\\nz\\n' | wc -l -w -c"},
  {uses: ['xargs', 'tee', 'paste'], line: 'seq 4 | xargs -n2 echo; echo t | tee /tmp/te >/dev/null; cat /tmp/te; seq 2 > /tmp/p1; seq 3 4 > /tmp/p2; paste /tmp/p1 /tmp/p2; paste -sd, /tmp/p1'},
  {uses: ['join'], line: "printf '1 a\\n2 b\\n' > /tmp/j1; printf '1 x\\n2 y\\n' > /tmp/j2; join /tmp/j1 /tmp/j2"},
  {uses: ['split'], line: "cd /tmp && seq 10 | split -l 4 - part_ && ls part_* | tr '\\n' ' ' && cat part_ac"},
  {uses: ['diff', 'patch'], line: "cd /tmp && printf 'a\\nb\\nc\\n' > o && printf 'a\\nB\\nc\\nd\\n' > n && diff -u o n > d; echo \"diff $?\"; patch o < d >/dev/null && cmp o n && echo patched"},
  {uses: ['column'], line: "printf 'a bb ccc\\ndddd e f\\n' | column -t"},
  {uses: ['nl', 'fold', 'expand', 'unexpand', 'od'], line: "printf 'x\\ny\\n' | nl; echo abcdefgh | fold -w 3; printf 'a\\tb\\n' | expand -t 4 | od -c | head -1; printf 'a       b\\n' | unexpand -a | od -c | head -1"},
  {uses: ['comm', 'tac'], line: "printf 'a\\nb\\nc\\n' > /tmp/c1; printf 'b\\nc\\nd\\n' > /tmp/c2; comm -12 /tmp/c1 /tmp/c2; seq 3 | tac | tr '\\n' ' '"},
  {uses: ['fmt'], line: "printf 'one two three four five six seven\\n' | fmt -w 12"},
  {uses: ['iconv'], line: "printf '\\xe9t\\xe9\\n' | iconv -f latin1 -t utf-8"},
  {uses: ['dos2unix', 'unix2dos'], line: "printf 'a\\r\\nb\\r\\n' > /tmp/dos && dos2unix /tmp/dos && od -c /tmp/dos | head -1; unix2dos /tmp/dos && od -c /tmp/dos | head -1"},
  // Search
  {uses: ['rg'], line: "cd /tmp && mkdir -p g && printf 'fn main() {}\\nlet x = 1;\\n' > g/a.rs && printf 'main here\\n' > g/b.txt && rg -n main g | sort; rg -c --type rust let g"},
  {uses: ['fd'], line: 'cd /tmp && mkdir -p h/s && touch h/s/one.rs h/two.rs h/t.txt && fd -e rs . h | sort'},
  {uses: ['fzf'], line: "printf 'apple\\nbanana\\ncherry\\n' | fzf --filter=an"},
  {uses: ['which'], line: 'which sh git'},
  {uses: ['whereis'], line: "whereis ls | cut -d' ' -f1"},
  // Terminal (what does not need one)
  {uses: ['clear'], line: 'clear | od -c | head -1'},
  {uses: ['tput'], line: 'tput colors; tput bold | od -c | head -1; tput cols'},
  {uses: ['reset'], line: 'command -v reset >/dev/null && echo reset'},
  {uses: ['tty', 'stty'], line: 'tty; echo "tty $?"; stty -a </dev/null >/dev/null 2>&1; echo "stty $?"'},
  {uses: ['watch', 'timeout'], line: 'timeout 2 watch -n 1 -t echo hi >/dev/null 2>&1; echo watched'},
  // Inspect
  {uses: ['file', 'strings'], line: "file /bin/busybox | cut -d, -f1; printf 'abc\\0defgh\\0' > /tmp/st && strings -n 4 /tmp/st"},
  {uses: ['xxd', 'od', 'hexdump'], line: "printf 'AB\\n' | xxd; printf 'AB\\n' | od -An -tx1; printf 'AB\\n' | hexdump -C | head -1; printf 4142 | xxd -r -p; echo"},
  // Checksum
  {uses: ['md5sum', 'sha1sum', 'sha256sum', 'sha512sum', 'cksum'], line: 'printf abc | md5sum; printf abc | sha1sum; printf abc | sha256sum; printf abc | sha512sum | cut -c1-16; printf abc | cksum'},
  {uses: ['b2sum'], line: 'printf abc | b2sum | cut -c1-32'},
  {uses: ['openssl'], line: "printf abc | openssl dgst -sha256 | cut -d' ' -f2; echo hi | openssl base64; openssl rand -hex 4 | wc -c"},
  // Archives
  {uses: ['tar', 'gzip', 'gunzip'], line: 'cd /tmp && mkdir -p ar/d && echo z > ar/d/f && tar czf ar.tgz -C ar d && tar tzf ar.tgz && gzip -c ar/d/f > f.gz && gunzip -c f.gz'},
  {uses: ['zip', 'unzip'], line: 'cd /tmp && mkdir -p zp && echo q > zp/q && zip -qr zp.zip zp && rm -r zp && unzip -q zp.zip && cat zp/q'},
  {uses: ['bzip2', 'xz', 'zstd'], line: 'cd /tmp && seq 1000 > n && bzip2 -k n && xz -k n && zstd -q n -o n.zst && bzip2 -dc n.bz2 | tail -1 && xz -dc n.xz | tail -1 && zstd -dcq n.zst | tail -1'},
  {uses: ['tar', 'xz', 'zstd'], line: 'cd /tmp && mkdir -p tz && seq 10 > tz/s && tar cJf tz.txz tz && tar --zstd -cf tz.tzst tz && tar tJf tz.txz && tar --zstd -tf tz.tzst'},
  // Data
  {uses: ['jq'], line: `echo '{"a":[1,2,{"b":"c"}]}' | jq -c '.a[2], (.a | length), ([.a[] | numbers] | add)'`},
  {uses: ['yq'], line: "printf 'a:\\n  b: [1, 2]\\n' | yq '.a.b[1]'"},
  {uses: ['base64'], line: 'echo hello | base64; echo aGVsbG8K | base64 -d'},
  {uses: ['sqlite3'], line: "sqlite3 /tmp/d.db 'create table t(x); insert into t values (1),(2); select sum(x) from t;'"},
  // Network (what needs no host outside)
  {uses: ['ssh', 'scp', 'sftp'], line: 'ssh -V 2>&1 | cut -d, -f1; command -v scp sftp | wc -l'},
  {uses: ['nc', 'nslookup', 'ping', 'traceroute'], line: 'command -v nc nslookup ping traceroute | wc -l'},
  {uses: ['ip', 'ss'], line: 'ip -o link show lo | cut -d: -f2; ss -l >/dev/null 2>&1; echo "ss $?"'},
  {uses: ['curl', 'wget'], line: 'echo hi > /tmp/c && curl -s file:///tmp/c; wget --help >/dev/null 2>&1; echo "wget $?"'},
  // Editor (what needs no screen)
  {uses: ['vi'], line: "cd /tmp && printf 'one\\ntwo\\n' > e && vi -c ':%s/one/ONE/' -c ':wq' e >/dev/null 2>&1 </dev/null; cat e"},
  {uses: ['nano', 'less', 'more'], line: "nano --version | head -1 | cut -d' ' -f1-2; printf 'paged\\n' | less; printf 'more\\n' | more"},
  // Development
  {uses: ['git'], line: 'cd /tmp && git init -q gr && cd gr && git config user.email a@b && git config user.name a && echo x > f && git add f && git commit -qm first && echo y >> f && git diff --stat | tail -1 && git commit -qam second && git log --oneline | wc -l && git switch -qc b2 && git rev-parse --abbrev-ref HEAD'},
  {uses: ['make'], line: "cd /tmp && mkdir -p mk && cd mk && printf 'all: out\\nout: in\\n\\tcp in out\\n' > Makefile && echo i > in && make -s && cat out && make -q; echo \"up to date $?\""},
  {uses: ['gcc', 'cc'], line: `cd /tmp && printf '#include <stdio.h>\\nint main(void){double d=7.3*12; printf("%%g\\\\n", d); return 0;}\\n' > m.c && gcc -O2 -Wall m.c -o m && ./m && cc -c m.c -o m.o && echo cc`},
  {uses: ['ld', 'ar', 'nm', 'objdump', 'readelf', 'strip', 'addr2line'], line: "cd /tmp && printf 'int f(void){return 1;}\\n' > lib.c && gcc -g -c lib.c && ar rcs libf.a lib.o && nm libf.a | grep -c ' T f' && objdump -d lib.o | grep -c '<f>:' && readelf -h lib.o | grep -c ELF64 && strip -o s.o lib.o && ld -r -o r.o lib.o && echo linked && addr2line -e lib.o 0 | cut -d: -f1 | xargs basename"},
  {uses: ['pkg-config'], line: 'pkg-config --version >/dev/null && echo pkg-config'},
  // Process
  {uses: ['ps', 'top'], line: 'ps | head -1 | cut -c1-20; top -bn1 | head -1 | cut -c1-4'},
  {uses: ['time', 'timeout', 'env', 'sleep'], line: "time -p true 2>&1 | head -1 | cut -c1-4; timeout 1 sleep 5; echo \"timeout $?\"; env -i A=1 sh -c 'echo $A'; sleep 0.1 && echo slept"},
  // (Each waits until sleep is there: begun with &, it is the shell's fork, not yet sleep, for a moment.)
  {uses: ['pgrep', 'pkill', 'killall'], line: 'sleep 30 & until pgrep -x sleep >/dev/null; do :; done; echo found; pkill -x sleep; wait; sleep 30 & until pgrep -x sleep >/dev/null; do :; done; killall sleep; wait; echo killed'},
  {uses: ['nice'], line: "nice -n 5 sh -c 'echo nice'; nice"},
  {uses: ['renice'], line: 'sleep 2 & renice -n 3 -p $! >/dev/null && echo reniced; kill $!'},
  {uses: ['nohup'], line: 'cd /tmp && nohup sh -c "echo kept" > o 2>/dev/null; cat o'},
  {uses: ['uptime', 'free', 'lsof', 'fuser'], line: 'uptime >/dev/null && echo up; free | head -1 | cut -c1-20; lsof >/dev/null 2>&1; echo "lsof $?"; fuser /tmp >/dev/null 2>&1; echo "fuser $?"'},
  // Debug
  {uses: ['strace'], line: 'strace -f -e trace=write echo hi 2>&1 | grep -c write'},
  // The shell's builtins, and what #80 asks of the shell itself.
  {uses: ['builtins'], line: `for b in ${BUILTINS.join(' ')}; do type $b >/dev/null 2>&1 || printf '%s ' "$b"; done; echo all`},
  {uses: ['variables'], line: `X=1; export Y=2; sh -c 'echo "$X|$Y"'; unset Y; echo "\${Y:-unset}"`},
  {uses: ['functions'], line: 'f() { local v=in; echo "$v $1"; }; v=out; f arg; echo $v'},
  {uses: ['arithmetic'], line: 'i=5; i=$((i*3+1)); echo $i $((16#ff)) $((7%3)) $((1<<10))'},
  {uses: ['parameter-expansion'], line: 'p=/a/b/c.tar.gz; echo ${p##*/} ${p%%.*} ${p#*.} ${#p} ${p/a/A} ${q:=dflt} $q'},
  {uses: ['command-substitution'], line: 'echo "$(echo a $(echo b))" `echo c`'},
  {uses: ['pipes-and-redirection'], line: '{ echo out; echo err >&2; } 2>&1 >/dev/null | tr a-z A-Z; echo x > /tmp/r1; echo y >> /tmp/r1; cat < /tmp/r1; exec 3>/tmp/r2; echo fd3 >&3; exec 3>&-; cat /tmp/r2'},
  {uses: ['globbing'], line: 'cd /tmp && mkdir -p gl && cd gl && touch a.c b.c c.h .hid && echo *.c; echo [ab].*; echo ?.h; echo nomatch*'},
  {uses: ['control-flow'], line: 'for i in 1 2 3; do if [ $i -eq 2 ]; then continue; fi; echo f$i; done; n=0; while [ $n -lt 2 ]; do n=$((n+1)); done; until [ $n -eq 0 ]; do n=$((n-1)); done; case x.c in *.h) echo h;; *.c) echo c;; esac'},
  {uses: ['and-or'], line: 'true && echo and; false || echo or; false && echo no; ! false && echo not'},
  {uses: ['jobs-and-signals'], line: "sleep 30 & p=$!; kill -TERM $p; wait $p; echo \"status $?\"; trap 'echo trapped' USR1; kill -USR1 $$; (sleep 0.1; exit 3) & wait $!; echo \"bg $?\""},
  {uses: ['subshells'], line: 'x=1; (x=2; echo in $x); echo out $x; (cd /tmp && pwd); pwd'},
  {uses: ['here-documents'], line: "cat <<EOF\nline ${HOME}\nEOF\ncat <<'EOF'\nraw $HOME\nEOF\nread -r a b <<EOF\none two\nEOF\necho $b"},
  {uses: ['exit-status'], line: "sh -c 'exit 7'; echo $?; false | true; echo $?; set -o pipefail; false | true; echo $?; sh -c 'kill -TERM $$'; echo $?"},
  {uses: ['shebang'], line: "cd /tmp && printf '#!/bin/sh\\necho shebang \"$1\"\\n' > s.sh && chmod +x s.sh && ./s.sh arg; printf '#!/usr/bin/env bash\\necho bash\\n' > b.sh && chmod +x b.sh && ./b.sh"},
];

/** What the shell is asked for beside its programs (#80's shell features), each its own line above. */
export const FEATURES = ['builtins', 'variables', 'functions', 'arithmetic', 'parameter-expansion', 'command-substitution', 'pipes-and-redirection',
  'globbing', 'control-flow', 'and-or', 'jobs-and-signals', 'subshells', 'here-documents', 'exit-status', 'shebang'];

/** How a run ended. */
interface Ended { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function run(cmd: string, argv: string[], seconds: number, env: NodeJS.ProcessEnv = process.env): Promise<Ended> {
  return new Promise((resolve) => {
    const p = spawn(cmd, argv, {stdio: ['ignore', 'pipe', 'pipe'], env});
    const out: Buffer[] = [], err: Buffer[] = [];
    let timedOut = false;
    p.stdout.on('data', (b: Buffer) => out.push(b));
    p.stderr.on('data', (b: Buffer) => err.push(b));
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, seconds * 1000);
    p.on('close', (code) => { clearTimeout(timer); resolve({code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut}); });
  });
}

/** The root as a Prompt on the device has it: its own /, /dev, /proc, /tmp and /root, no network, nothing of this machine's,
 * and its user root (uid 0 in a namespace of its own, as root3 starts a Prompt), whoever runs this. */
const sandbox = (root: string) => ['--unshare-all', '--unshare-user', '--uid', '0', '--gid', '0', '--die-with-parent', '--ro-bind', root, '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
  '--tmpfs', '/root', '--chdir', '/root', '--clearenv', ...ENV.flatMap((e) => ['--setenv', ...e.split(/=(.*)/s).slice(0, 2)])];

/** What a line did, natively and here, and whether those are the same. */
export interface Tried { line: Line; same: boolean; native: Ended; here: Ended & {error: string | null} }

/** A line natively, then under xlat (webroot-runnable.ts --child runs one program as the browser's Prompt runs it). */
async function attempt(line: Line, web: string, root: string, seconds: number): Promise<Tried> {
  const native = await run('bwrap', [...sandbox(root), '/bin/sh', '-c', line.line], seconds);
  // The same environment as natively: what a person's Prompt has.
  const asked: Asked = {web, path: '/bin/sh', args: ['-c', line.line], translator: `${OS}module/sods/target/wasm32-unknown-unknown/release/xlat.wasm`, fresh: false, kept: null, env: ENV};
  const child = await run(process.execPath, [`${OS}scripts/webroot-runnable.ts`, '--child', JSON.stringify(asked)], seconds, {...process.env, XLAT_INLINE: '1'});
  let said: {status: number | null; stdout: string; stderr: string; error: string | null} | null = null;
  try { said = JSON.parse(child.stdout); } catch { /* it ended without saying: killed, or the kernel threw */ }
  // A wait status: an exit's code, or 128 and the signal, as a shell says it.
  const status = said?.status ?? null;
  const code = status === null ? null : status & 0x7f ? 128 + (status & 0x7f) : status >> 8;
  const here = {code, stdout: said?.stdout ?? '', stderr: said?.stderr ?? child.stderr.slice(-400), timedOut: child.timedOut,
    error: said ? said.error : child.timedOut ? `no end within ${seconds} s` : 'the kernel stopped'};
  // The shell names itself by its path natively and by its name here: what it says is otherwise the same.
  const same = !here.error && !here.timedOut && here.code === native.code && here.stdout === native.stdout
    && here.stderr.replace(/^sh: /gm, '/bin/sh: ') === native.stderr;
  return {line, same, native, here};
}

/** Each command's mark: what was seen of it, and what instead when the root has none. */
export function marks(tried: Tried[], has: (name: string) => boolean): Map<string, {mark: '+' | 't' | 'x' | '-'; why: string}> {
  const out = new Map<string, {mark: '+' | 't' | 'x' | '-'; why: string}>();
  const names = [...KINDS.flatMap((k) => k.commands), ...FEATURES];
  for (const name of names) {
    const lines = tried.filter((t) => t.line.uses.includes(name));
    const failed = lines.find((t) => !t.same);
    const feature = FEATURES.includes(name);
    if (!feature && !has(name)) out.set(name, {mark: '-', why: INSTEAD[name] ?? ''});
    else if (failed) out.set(name, {mark: 'x', why: whyNot(failed)});
    else if (!lines.length) throw new Error(`${name}: no line uses it`);
    else out.set(name, {mark: SCREEN.has(name) ? 't' : '+', why: ''});
  }
  return out;
}

/** Why a line did not end as natively, in a few words: what the kernel said, else what it said otherwise. */
function whyNot(t: Tried): string {
  const words = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 100);
  if (t.here.error) return words(t.here.error);
  if (t.here.code !== t.native.code) return words(`ends ${t.here.code}, natively ${t.native.code}${t.here.stderr ? `: ${t.here.stderr.split('\n')[0]}` : ''}`);
  const err = t.here.stderr.split('\n').find((l) => l.trim() && !t.native.stderr.includes(l));
  if (err) return words(err);
  const a = t.here.stdout.split('\n'), b = t.native.stdout.split('\n');
  const k = a.findIndex((l, i) => l !== b[i]);
  return words(`says ${JSON.stringify(a[k] ?? '')}, natively ${JSON.stringify(b[k] ?? '')}`);
}

/** The table `help` reads: a line a command, by tabs (name, kind, mark, instead or why), the kinds in #80's order. */
export function table(m: ReturnType<typeof marks>, builtins: string[]): string {
  const rows = [...KINDS.flatMap((k) => k.commands.map((c) => [c, k.kind] as const)), ...FEATURES.map((f) => [f, 'shell'] as const)];
  const lines = rows.map(([name, kind]) => {
    const {mark, why} = m.get(name) ?? {mark: '-', why: ''};
    return `${name}\t${kind}\t${mark}\t${why}`;
  });
  // The shell's builtins, each there unless the line that asks for them all named it as not.
  for (const b of BUILTINS) lines.push(`${b}\tbuiltin\t${builtins.includes(b) ? '-' : '+'}\t`);
  return `# What a Prompt runs, as scripts/commands.ts saw it: name, kind, mark (+ runs, t needs a terminal, x not yet here, - not in the root), why or what instead.\n${lines.join('\n')}\n`;
}

async function main() {
  const {values, positionals} = parseArgs({allowPositionals: true, options: {only: {type: 'string'}, jobs: {type: 'string'}, seconds: {type: 'string'},
    write: {type: 'boolean'}, check: {type: 'boolean'}}});
  const [web, root] = positionals;
  if (!web || !root) { console.error('usage: node scripts/commands.ts WEB ROOT_DIR [--only REGEX] [--jobs N] [--seconds N] [--write | --check]'); process.exit(2); }
  const only = values.only ? new RegExp(values.only) : null;
  const jobs = Number(values.jobs ?? Math.max(1, availableParallelism() - 1)), seconds = Number(values.seconds ?? 60);
  const w = openWeb(web);
  const programs = new Set([...w.index.files, ...w.index.links].map((f) => f.path).filter((p) => /^\/usr\/s?bin\/[^/]+$/.test(p)).map((p) => p.slice(p.lastIndexOf('/') + 1)));
  w.close();
  const lines = LINES.filter((l) => !only || l.uses.some((u) => only.test(u)));
  const tried: Tried[] = new Array(lines.length);
  let next = 0;
  await Promise.all(Array.from({length: jobs}, async () => {
    for (let k = next++; k < lines.length; k = next++) {
      const t = tried[k] = await attempt(lines[k]!, web, root, seconds);
      const show = (s: string) => JSON.stringify(s.length > 200 ? `${s.slice(0, 200)}…` : s);
      if (t.same) console.log(`same   ${t.line.uses.join(' ')}`);
      else console.log(`DIFFER ${t.line.uses.join(' ')}\n  native ${t.native.code} ${show(t.native.stdout)}${t.native.stderr ? ` err ${show(t.native.stderr)}` : ''}`
        + `\n  here   ${t.here.code} ${show(t.here.stdout)}${t.here.stderr ? ` err ${show(t.here.stderr)}` : ''}${t.here.error ? ` (${t.here.error})` : ''}`);
    }
  }));
  console.log(`${tried.filter((t) => t.same).length} of ${tried.length} lines end here as natively`);
  if (!values.write && !values.check) return;
  if (only) throw new Error('--write and --check take every line: not with --only');
  // The builtins the shell has not: those the line that asks for them all names, natively, before its "all".
  const missing = (tried.find((t) => t.line.uses.includes('builtins'))?.native.stdout ?? '').replace(/all\s*$/, '').split(/\s+/).filter(Boolean);
  const out = table(marks(tried, (n) => programs.has(n)), missing);
  const at = `${OS}module/ricebox/etc/length3/commands`;
  if (values.check) {
    const kept = readFileSync(at, 'utf8').split('\n'), seen = out.split('\n');
    const differ = seen.filter((l) => !kept.includes(l));
    if (!differ.length && kept.length === seen.length) { console.log(`module/ricebox/etc/length3/commands: what was seen, all ${seen.length - 2} commands`); return; }
    console.error(`module/ricebox/etc/length3/commands is not what was seen (node scripts/commands.ts ${web} ${root} --write makes it so):\n${differ.map((l) => `  ${l}`).join('\n')}`);
    process.exit(1);
  }
  writeFileSync(at, out);
  console.log(`module/ricebox/etc/length3/commands: ${out.split('\n').length - 2} commands`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
