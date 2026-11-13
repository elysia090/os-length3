#!/bin/sh
# Small bounded footprint trials, using the common profiler's ownership-limited cleanup.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
if [ "$#" -gt 2 ]; then echo "usage: dense.sh [N [MUK]]" >&2; exit 2; fi
if [ "$#" -eq 2 ]; then exec sh "$here/../tool/profile.sh" --memory --boxes "$1" "$2"; fi
exec sh "$here/../tool/profile.sh" --memory --boxes "${1:-8}"
