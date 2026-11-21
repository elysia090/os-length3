#!/bin/sh
# Raw, bounded lifecycle/footprint trials; optional parser A/B. --help explains the measured boundaries.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
exec python3 "$here/profile.py" "$@"
