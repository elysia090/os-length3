#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 || ! -d $1 ]]; then
  printf 'usage: %s SERVICE-SOURCE\n' "$0" >&2
  exit 2
fi
source_root=$(realpath -e -- "$1")
longruns=0
for service in "$source_root"/*; do
  [[ -d $service && -f $service/type ]] || continue
  [[ $(<"$service/type") == longrun ]] || continue
  [[ -s $service/run ]] || {
    printf 'longrun has no executable run source: %s\n' "$service" >&2
    exit 1
  }
  # s6-supervise calls execve directly; shell fallback is not its contract.
  # All release-owned longruns use the installed /bin/sh interpreter.
  IFS= read -r interpreter <"$service/run"
  if [[ $interpreter != '#!/bin/sh' ]]; then
    printf 'longrun run source must begin with #!/bin/sh: %s\n' "$service" >&2
    exit 1
  fi
  sh -n "$service/run"
  ((longruns += 1))
done
((longruns > 0)) || {
  printf 'service source contains no longruns: %s\n' "$source_root" >&2
  exit 1
}
printf 'service executable sources: green (%s longruns)\n' "$longruns"
