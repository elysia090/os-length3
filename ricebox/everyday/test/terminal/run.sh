#!/bin/sh
set -eu
if [ "$#" -ne 3 ]; then
  echo "usage: $0 TRANSLATOR_WASM MUK STATIC_BUSYBOX" >&2
  exit 2
fi

# Run from the repository root with its ordinary locked Node dependencies.
tests=ricebox/everyday/test
scratch=$(mktemp -d)
trap 'rm -rf -- "$scratch"' EXIT
node "$tests/wayland/browser/stage-consumer.mjs" "$scratch/installed"
browser="$scratch/installed/consumer/browser"
cp "ricebox/everyday/terminal/vt.ts" "$browser/vt.ts"
cp "$tests/terminal/pty.integration.mjs" "$browser/terminal-pty.integration.mjs"
node "$browser/terminal-pty.integration.mjs" "$@"
