import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

// Exercise the build script's actual dependency walk and record writer. Only the expensive
// compilation is substituted: each recipe still has its own inputs and cached output.
function build(names: string[]) {
  const at = mkdtempSync(join(tmpdir(), 'ricebox-selection-'));
  try {
    const out = join(at, 'out'), recipes = join(at, 'recipes');
    for (const name of ['app', 'base', 'extra']) {
      mkdirSync(join(out, name), {recursive: true});
      mkdirSync(join(recipes, name), {recursive: true});
      writeFileSync(join(recipes, name, 'recipe.sh'), name === 'app' ? 'needs="base"\n' : 'needs=""\n');
      for (const [file, value] of [['key', 'same'], ['version', '1.0'], ['source', name + '-digest']]) writeFileSync(join(out, name, file), value);
    }
    const source = readFileSync(new URL('../ricebox/distribution/build/packages.sh', import.meta.url), 'utf8');
    const mark = '# Each NAME after what it needs, made only when its key is not the one kept.';
    assert.ok(source.includes(mark));
    const harness = `set -eu\nout=$1; recipes=$2; shift 2\nall='app base extra'\n` +
      `field() { ( needs=''; . "$recipes/$1/recipe.sh"; printf '%s' "$needs"; ); }\n` +
      `key_of() { printf same; }\nsay() { :; }\nmake_one() { echo unexpected-build >&2; exit 1; }\n` + source.slice(source.indexOf(mark));
    const script = join(at, 'run.sh');
    writeFileSync(script, harness);
    const result = spawnSync('sh', [script, out, recipes, ...names], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(join(out, 'record'), 'utf8');
  } finally { rmSync(at, {recursive: true, force: true}); }
}

test('a selected deployment records its dependency closure, not unrelated cached packages', () => {
  assert.equal(build(['app']), 'app 1.0 app-digest\nbase 1.0 base-digest\n');
});

test('removing a package from a later selection removes it from the deployment record', () => {
  assert.equal(build(['base']), 'base 1.0 base-digest\n');
});

test('the default distribution keeps every package and the existing deterministic order', () => {
  assert.equal(build([]), 'app 1.0 app-digest\nbase 1.0 base-digest\nextra 1.0 extra-digest\n');
});
