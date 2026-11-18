d=$(mktemp -d) || exit; trap 'rm -rf "$d"' EXIT; cd "$d" || exit
set -e
cat > package.json <<'EOF'
{"name":"ricebox-assay","version":"1.0.0","private":true,"scripts":{"test":"node test.cjs"}}
EOF
printf '%s\n' "require('node:assert/strict').equal(12 + 30, 42)" > test.cjs
npm --offline --ignore-scripts install --no-audit --no-fund > result 2>&1 || { cat result; exit 1; }
npm --offline --silent test > result 2>&1 || { cat result; exit 1; }
echo npm-project-ok