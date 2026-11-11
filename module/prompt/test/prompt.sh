#!/bin/sh
# prompt, checked at a terminal: a box run through it is typed to and shows what it says, has this terminal's size,
# and ends prompt as it ends; what muk refuses, prompt says and ends with; nothing of its own is left behind; this
# terminal gone, the box is.
#
#   sh prompt/test/prompt.sh
#
# The terminal is script(1)'s. A user namespace is made, so any user runs it.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
module=$(cd "$here/../.." && pwd)
t=$(mktemp -d)
trap '[ -n "${KEEP:-}" ] || rm -rf "$t"' EXIT; [ -z "${KEEP:-}" ] || echo "# kept: $t"
for unit in muk/src/muk prompt/src/prompt prompt/test/talk; do sh "$module/lib/build.sh" "$module/$unit.c" "$t/$(basename "$unit")"; done
n=0
no() { printf 'not ok %d: %s\n' "$n" "$*" >&2; exit 1; }
mkdir -p "$t/box/rootfs" "$t/run" && cp "$t/talk" "$t/box/rootfs/talk"
config() { # config TERMINAL: the box's config.json, with a terminal or without
  cat > "$t/box/config.json" <<JSON
{"process": {"terminal": $1, "args": ["/talk"], "cwd": "/"}, "root": {"path": "rootfs"},
 "mounts": [{"destination": "/dev/pts", "type": "devpts", "source": "devpts", "options": ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620"]}],
 "linux": {"namespaces": [{"type": "pid"}, {"type": "network"}, {"type": "ipc"}, {"type": "uts"}, {"type": "mount"}, {"type": "user"}],
  "uidMappings": [{"containerID": 0, "hostID": $(id -u), "size": 1}], "gidMappings": [{"containerID": 0, "hostID": $(id -g), "size": 1}]}}
JSON
}
# at_terminal: what is typed (standard input) typed at a terminal 31 by 97 where prompt runs the box; what the terminal
# shows is in $t/shown, how prompt ended in $ended.
at_terminal() {
  ended=0
  (cd "$t/box" && XDG_RUNTIME_DIR="$t/run" timeout 60 script -qec "stty rows 31 cols 97; exec '$t/prompt' run -b ." /dev/null) > "$t/raw" 2>&1 || ended=$?
  tr -d '\r' < "$t/raw" > "$t/shown"
}

# What is typed here is typed there; what it says is shown here; its terminal is this one's size; it ends as the box does.
config true
n=$((n + 1))
printf 'hello there\nsize\nexit 5\n' > "$t/typed"; at_terminal < "$t/typed"
[ "$ended" = 5 ] || no "prompt ended $ended, not 5 as its box did: $(cat "$t/shown")"
for line in 'you said: hello there' 'size 31 97'; do
  n=$((n + 1)); grep -qxF "$line" "$t/shown" || no "the terminal did not show: $line: $(cat "$t/shown")"
done
n=$((n + 1)); grep -q '^ready ' "$t/shown" || no "the box did not start at a terminal"
# What was typed ended (no exit): the box is told so, and ends itself.
n=$((n + 1))
printf 'one\n' > "$t/typed"; at_terminal < "$t/typed"
[ "$ended" = 0 ] && grep -qxF 'you said: one' "$t/shown" || no "typing ended: prompt ended $ended: $(cat "$t/shown")"
# Nothing of its own is left where its socket was.
n=$((n + 1)); [ -z "$(ls -A "$t/run")" ] || no "left behind: $(ls -A "$t/run")"

# What muk does not run, prompt says as muk said it, and ends as muk did; and still leaves nothing.
config false
n=$((n + 1))
at_terminal < /dev/null
[ "$ended" = 1 ] && grep -q 'config.json asks for no terminal' "$t/shown" || no "no terminal asked for: prompt ended $ended: $(cat "$t/shown")"
n=$((n + 1)); [ -z "$(ls -A "$t/run")" ] || no "left behind: $(ls -A "$t/run")"
n=$((n + 1))
ended=0; (cd "$t/box" && MUK="$t/no-such-muk" XDG_RUNTIME_DIR="$t/run" "$t/prompt" run -b . < /dev/null) > "$t/shown" 2>&1 || ended=$?
[ "$ended" = 127 ] && grep -q 'muk is not run' "$t/shown" && [ -z "$(ls -A "$t/run")" ] || no "no muk: prompt ended $ended: $(cat "$t/shown")"

# This terminal gone, the box is: no process of it is left.
config true
n=$((n + 1))
mkfifo "$t/typing" # (typed to and never ended: nothing is typed, and the box waits)
(cd "$t/box" && XDG_RUNTIME_DIR="$t/run" exec "$t/prompt" run -b . <> "$t/typing" > "$t/shown" 2>&1) &
p=$!
i=0
until grep -q '^ready ' "$t/shown" 2> /dev/null; do
  i=$((i + 1)); [ "$i" -lt 500 ] || no "the box did not start: $(cat "$t/shown")"
  sleep 0.01
done
# (prompt's child is muk, and muk's the box's first process)
muk=$(cat "/proc/$p/task/$p/children"); muk=${muk% }
box=$(cat "/proc/$muk/task/$muk/children"); box=${box% }
[ -n "$muk" ] && [ -n "$box" ] || no "the box's process is not found"
kill -HUP "$p"; wait "$p" 2> /dev/null || :
i=0
for one in $box; do
  while [ -e "/proc/$one" ] && ! grep -q '^State:.Z' "/proc/$one/status" 2> /dev/null; do
    i=$((i + 1)); [ "$i" -lt 500 ] || { kill -9 "$one"; no "the terminal was gone and the box went on"; }
    sleep 0.01
  done
done
echo "ok $n"
