import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import {test} from 'node:test';

// The workflows that build, test and release this repository, held to what supply-chain guidance asks
// (OpenSSF Scorecard: Pinned-Dependencies, Token-Permissions, Dangerous-Workflow; SLSA build L1-L2).
const dir = new URL('../../../.github/workflows/', import.meta.url);
const flows = readdirSync(dir).filter((f) => f.endsWith('.yml')).map((f) => ({name: f, text: readFileSync(new URL(f, dir), 'utf8')}));

test('every action is pinned to a full commit, its tag beside it', () => {
  assert.ok(flows.length >= 4);
  const loose = flows.flatMap(({name, text}) => [...text.matchAll(/uses:\s*(\S+)(.*)$/gm)]
    .filter(([, ref, rest]) => !/@[0-9a-f]{40}$/.test(ref) || !/#\s*v\d/.test(rest)).map(([, ref]) => `${name}: ${ref}`));
  assert.deepEqual(loose, []);
});

test('each workflow\'s token reads by default, and writes only in the job that releases', () => {
  for (const {name, text} of flows) {
    assert.match(text, /^permissions:\n\s+contents: read$/m, name);
    const writes = [...text.matchAll(/^\s+\w+: write$/gm)].length;
    assert.equal(writes, name === 'release.yml' ? 1 : 0, name);
  }
  assert.match(flows.find((f) => f.name === 'release.yml')!.text, /branches: \['main'\]/);
});

test('no workflow runs untrusted code with a privileged token, or pastes event text into a shell', () => {
  for (const {name, text} of flows) {
    assert.doesNotMatch(text, /pull_request_target|workflow_run/, name);
    // An expression is handed to a step by env: (KEY: ${{ … }}), never written where a shell would read it as code.
    const runs = text.split('\n').filter((l) => !/^\s+[A-Z][A-Z0-9_]*: \$\{\{[^}]*\}\}\s*$/.test(l));
    assert.deepEqual(runs.filter((l) => /\$\{\{\s*(github\.event|inputs\.|github\.head_ref)/.test(l)), [], name);
  }
});

test('what is built is what the lockfiles say', () => {
  for (const {name, text} of flows) {
    assert.doesNotMatch(text, /npm install(?! -g)|npm i /, name);
    const cargo = [...text.matchAll(/^\s+cargo (build|test|run|install)\b.*$/gm)].map((m) => m[0]);
    assert.deepEqual(cargo.filter((l) => !l.includes('--locked')), [], name);
  }
  assert.match(flows.find((f) => f.name === 'desktop.yml')!.text, /npm audit --omit=dev --audit-level=high/);
  assert.ok(readFileSync(new URL('../../../.github/dependabot.yml', import.meta.url), 'utf8').includes('package-ecosystem: github-actions'));
});
