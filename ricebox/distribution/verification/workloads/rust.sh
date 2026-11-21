d=$(mktemp -d) || exit; trap 'rm -rf "$d"' EXIT; cd "$d" || exit
set -e
cat > main.rs <<'EOF'
fn main() { let values = vec![12, 30]; let total: i32 = values.iter().sum(); assert_eq!(total, 42); println!("{}", total); }
EOF
rustc main.rs -o app
./app