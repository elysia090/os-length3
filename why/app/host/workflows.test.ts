import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {test} from 'node:test';

// The workflows that build, test and release this repository, and the actions of its own they share
// (.github/actions/NAME), held to what supply-chain guidance asks (OpenSSF Scorecard: Pinned-Dependencies,
// Token-Permissions, Dangerous-Workflow; SLSA build L1-L2).
const github = new URL('../../../.github/', import.meta.url);
const dir = new URL('workflows/', github);
const flows = readdirSync(dir).filter((f) => f.endsWith('.yml')).map((f) => ({name: f, text: readFileSync(new URL(f, dir), 'utf8')}));
const actions = readdirSync(new URL('actions/', github))
  .map((a) => ({name: `actions/${a}`, text: readFileSync(new URL(`actions/${a}/action.yml`, github), 'utf8')}));
const steps = [...flows, ...actions];

test('every action is pinned to a full commit, its tag beside it, or is one of this tree\'s own', () => {
  assert.ok(flows.length >= 4);
  // One of this tree's own is the commit's, as the workflow is, and is held to the same rules (below).
  const own = (ref: string) => /^\.\/\.github\/actions\/[\w-]+$/.test(ref) && existsSync(new URL(`${ref.slice(10)}/action.yml`, github));
  const loose = steps.flatMap(({name, text}) => [...text.matchAll(/uses:\s*(\S+)(.*)$/gm)]
    .filter(([, ref, rest]) => !own(ref) && (!/@[0-9a-f]{40}$/.test(ref) || !/#\s*v\d/.test(rest))).map(([, ref]) => `${name}: ${ref}`));
  assert.deepEqual(loose, []);
});

test('each workflow\'s token reads by default, and writes only in the jobs that release and that delete releases, on main', () => {
  // What each may write: the release its repository's contents, its pins' pull request, and the provenance of what it
  // made (signed as the run: id-token, attestations); the prune the releases it deletes.
  const writers: Record<string, string[]> = {'release.yml': ['attestations', 'contents', 'id-token', 'pull-requests'], 'prune-releases.yml': ['contents']};
  for (const {name, text} of flows) {
    assert.match(text, /^permissions:\n\s+contents: read$/m, name);
    const writes = [...text.matchAll(/^\s+([\w-]+): write$/gm)].map(([, what]) => what).sort();
    assert.deepEqual(writes, writers[name] ?? [], name);
  }
  for (const name of Object.keys(writers)) assert.match(flows.find((f) => f.name === name)!.text, /branches: \['main'\]/, name);
  assert.match(flows.find((f) => f.name === 'prune-releases.yml')!.text, /if: github\.ref == 'refs\/heads\/main'/);
});

test('no workflow runs untrusted code with a privileged token, or pastes event text into a shell', () => {
  for (const {name, text} of steps) {
    assert.doesNotMatch(text, /pull_request_target|workflow_run/, name);
    // An expression is handed to a step by env: (KEY: ${{ … }}), never written where a shell would read it as code.
    const runs = text.split('\n').filter((l) => !/^\s+[A-Z][A-Z0-9_]*: \$\{\{[^}]*\}\}\s*$/.test(l));
    assert.deepEqual(runs.filter((l) => /\$\{\{\s*(github\.event|inputs\.|github\.head_ref)/.test(l)), [], name);
  }
});

test('what is built is what the lockfiles say', () => {
  for (const {name, text} of steps) {
    assert.doesNotMatch(text, /npm install(?! -g)|npm i /, name);
    const cargo = [...text.matchAll(/^\s+cargo (build|test|run|install)\b.*$/gm)].map((m) => m[0]);
    assert.deepEqual(cargo.filter((l) => !l.includes('--locked')), [], name);
  }
  assert.match(flows.find((f) => f.name === 'ci.yml')!.text, /npm audit --omit=dev --audit-level=high/);
  assert.ok(readFileSync(new URL('../../../.github/dependabot.yml', import.meta.url), 'utf8').includes('package-ecosystem: github-actions'));
});
