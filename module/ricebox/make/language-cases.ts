// Offline project-sized checks, run unchanged in native and translated roots by
// commands.ts. Package downloads and server previews have separate network tests.
// Missing commands retain the assay's '-' mark; these are not version probes.
const project = (body: string) => `d=$(mktemp -d) || exit; trap 'rm -rf "$d"' EXIT; cd "$d" || exit\nset -e\n${body}`;
export const LANGUAGE_LINES = [
  {uses: ['c++'], line: project(`cat > sum.hpp <<'EOF'
int sum();
EOF
cat > sum.cpp <<'EOF'
#include <vector>
#include <numeric>
#include <stdexcept>
#include "sum.hpp"
int sum() { std::vector<int> v{12, 30}; try { throw std::runtime_error("ok"); } catch (const std::exception&) { return std::accumulate(v.begin(), v.end(), 0); } }
EOF
cat > main.cpp <<'EOF'
#include <iostream>
#include "sum.hpp"
int main() { std::cout << sum() << '\\n'; return sum() != 42; }
EOF
c++ -std=c++17 -O2 main.cpp sum.cpp -o app
./app`)},
  {uses: ['python3'], line: project(`cat > test_project.py <<'EOF'
import json, sqlite3, ssl, subprocess, unittest
class Project(unittest.TestCase):
    def test_work(self):
        db = sqlite3.connect(":memory:")
        self.assertEqual(db.execute("select 12 + 30").fetchone()[0], 42)
        self.assertEqual(json.loads('{"answer":42}')["answer"], 42)
        self.assertEqual(subprocess.check_output(["sh", "-c", "printf child"]).decode(), "child")
        self.assertIsNotNone(ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT))
EOF
python3 -m unittest test_project > result 2>&1 || { cat result; exit 1; }
echo python-project-ok`)},
  {uses: ['node'], line: project(`cat > value.mjs <<'EOF'
export const value = 42;
EOF
cat > project.test.mjs <<'EOF'
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {value} from './value.mjs';
test('modules and subprocesses', () => { assert.equal(value, 42); assert.equal(execFileSync('sh', ['-c', 'printf child'], {encoding:'utf8'}), 'child'); });
EOF
node --test project.test.mjs > result 2>&1 || { cat result; exit 1; }
echo node-project-ok`)},
  {uses: ['npm'], line: project(`cat > package.json <<'EOF'
{"name":"ricebox-assay","version":"1.0.0","private":true,"scripts":{"test":"node test.cjs"}}
EOF
printf '%s\\n' "require('node:assert/strict').equal(12 + 30, 42)" > test.cjs
npm --offline --ignore-scripts install --no-audit --no-fund > result 2>&1 || { cat result; exit 1; }
npm --offline --silent test > result 2>&1 || { cat result; exit 1; }
echo npm-project-ok`)},
  {uses: ['rustc'], line: project(`cat > main.rs <<'EOF'
fn main() { let values = vec![12, 30]; let total: i32 = values.iter().sum(); assert_eq!(total, 42); println!("{}", total); }
EOF
rustc main.rs -o app
./app`)},
  {uses: ['cargo'], line: project(`mkdir src
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
echo cargo-project-ok`)},
  {uses: ['go', 'gofmt'], line: project(`cat > go.mod <<'EOF'
module ricebox.test/assay
go 1.20
EOF
cat > answer.go <<'EOF'
package answer
func Answer()int{return 42}
EOF
cat > answer_test.go <<'EOF'
package answer
import "testing"
func TestAnswer(t *testing.T) { if Answer() != 42 { t.Fatal("wrong answer") } }
EOF
gofmt -w answer.go answer_test.go
[ -z "$(gofmt -l answer.go answer_test.go)" ]
GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GOCACHE="$d/cache" go test ./... > result 2>&1 || { cat result; exit 1; }
echo go-project-ok`)},
];
