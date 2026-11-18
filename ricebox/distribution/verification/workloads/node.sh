d=$(mktemp -d) || exit; trap 'rm -rf "$d"' EXIT; cd "$d" || exit
set -e
cat > value.mjs <<'EOF'
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
echo node-project-ok