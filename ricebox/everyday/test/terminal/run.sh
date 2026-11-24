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
node "$tests/wayland/browser/stage-consumer.ts" "$scratch/installed"
browser="$scratch/installed/consumer/browser"
cp "ricebox/everyday/terminal/vt.ts" "$browser/vt.ts"
cp "$tests/wayland/browser/terminal-stream.mts" "$browser/terminal-stream.mts"
cp "$tests/terminal/pty.integration.ts" "$browser/terminal-pty.integration.ts"
node "$browser/terminal-pty.integration.ts" "$@"
cp "$tests/terminal/resize-lifecycle.integration.ts" "$browser/terminal-resize-lifecycle.integration.ts"
node "$browser/terminal-resize-lifecycle.integration.ts" "$@"
