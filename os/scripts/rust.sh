# Sourced by `npm run build:cloudflare`: the core the page runs (core/web) is built from this tree with Rust,
# and a build machine with only Node (Cloudflare's Workers Builds) gets a minimal toolchain for it first.
if ! command -v cargo >/dev/null 2>&1; then
  if [ ! -x "$HOME/.cargo/bin/cargo" ]; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --target wasm32-wasip1 --no-modify-path || return 1
  fi
  export PATH="$HOME/.cargo/bin:$PATH"
fi
# A toolchain already there may lack the target; rustup adds it (a system Rust without rustup says so at the build).
if command -v rustup >/dev/null 2>&1; then rustup target add wasm32-wasip1 >/dev/null 2>&1 || return 1; fi
