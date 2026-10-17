#!/bin/sh
# Guest-only check. A single make target cannot prove parallel compilation.
set -eu
work=$(mktemp -d /workspace/parallel-build.XXXXXXXX)
cd "$work"
for name in one two three four; do
    printf '#include <stdio.h>\nint main(void){puts("%s");return 0;}\n' "$name" >"$name.c"
done
printf 'all: one two three four\none two three four: %%: %%.c\n\t@%s\n' \
    'printf "start %s %s\n" $@ $$$$ >>build.events; if test ! -e .parallel-proved; then printf "%s\n" $$$$ >$@.begin; n=0; until test -f one.begin && test -f two.begin && test -f three.begin && test -f four.begin; do n=$$((n+1)); test $$n -lt 20 || exit 1; sleep 1; done; for p in one two three four; do kill -0 "$$(cat $$p.begin)" || exit 1; done; : >$@.ready; n=0; until test -f one.ready && test -f two.ready && test -f three.ready && test -f four.ready; do n=$$((n+1)); test $$n -lt 20 || exit 1; sleep 1; done; fi; cc $< -o $@; code=$$?; printf "compile %s %s\n" $@ $$code >>build.events; test $$code = 0 || exit $$code; ./$@ >$@.result; code=$$?; printf "end %s %s\n" $@ $$code >>build.events; exit $$code' \
    >Makefile
make -j4
for name in one two three four; do test "$(cat "$name.result")" = "$name"; done
for name in one two three four; do
    grep -qx "compile $name 0" build.events
    grep -qx "end $name 0" build.events
done
cat build.events
awk '/^start / {live++; if(live>maximum) maximum=live} /^end / {live--} END {exit(maximum!=4 || live!=0)}' build.events
printf 'browser-four-compilers:pass\n'
# A changed source must rebuild only its own target, then still execute.
: >.parallel-proved
sha256sum two three four >unchanged.before
printf '#include <stdio.h>\nint main(void){puts("one-new");return 0;}\n' >one.c
make -j4
test "$(./one)" = one-new
test "$(./two)" = two
sha256sum two three four >unchanged.after
cmp unchanged.before unchanged.after
printf 'int answer(void){return 42;}\n' >answer.c
printf 'extern int answer(void); int main(void){return answer()==42 ? 0 : 7;}\n' >linked.c
cc -c answer.c -o answer.o
cc -c linked.c -o linked.o
cc answer.o linked.o -o linked
./linked
printf 'browser-multisource-link:pass\n'
sync
printf 'browser-parallel-products:%s\n' "$work"
