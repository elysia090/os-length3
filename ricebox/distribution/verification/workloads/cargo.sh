d=$(mktemp -d) || exit; trap 'rm -rf "$d"' EXIT; cd "$d" || exit
set -e
mkdir src
cat > Cargo.toml <<'EOF'
[package]
name = "ricebox-assay"
version = "0.1.0"
edition = "2021"
EOF
cat > src/lib.rs <<'EOF'
pub fn answer() -> u32 { 42 }
#[test] fn computes() { assert_eq!(answer(), 42); }
EOF
cargo test --offline --quiet > result 2>&1 || { cat result; exit 1; }
echo cargo-project-ok