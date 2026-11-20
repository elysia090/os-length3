#!/bin/sh
set -eu
[ "$#" -eq 1 ] || { echo "usage: $0 WAYLAND_TEST_ELF" >&2; exit 2; }
: "${SODS_TRANSLATOR_WASM:?}" "${RICEBOX_MUK_FILE:?}"
# Run from the repository root with its ordinary locked dependencies.
test_dir=ricebox/everyday/test/wayland/browser
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
export EVERYDAY_CHROME_ASSETS="$temp/assets" EVERYDAY_CHROME_DIST="$temp/dist" EVERYDAY_CHROME_RESULTS="$temp/results"
set -- "$EVERYDAY_CHROME_ASSETS" "$SODS_TRANSLATOR_WASM" "$RICEBOX_MUK_FILE" "$1"
if [ -n "${EVERYDAY_SHELL_ELF:-}" ]; then set -- "$@" "$EVERYDAY_SHELL_ELF"; fi
node "$test_dir/stage.mjs" "$@"
node node_modules/vite/bin/vite.js build --config "$test_dir/vite.config.ts"
node node_modules/@playwright/test/cli.js test --config "$test_dir/playwright.config.ts"
