// The table of what sods is to make run (#191, runtime/targets.ts): whole, each state with its reason, and the one
// README.md shows the same.
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {ISAS, WHERES, owedTable, table, target, targets} from '../../runtime/targets.ts';

const root = new URL('../../../../', import.meta.url);

test('every input, machine and host has one state, said with its reason', () => {
  const rows = targets();
  assert.equal(rows.length, ISAS.length * ISAS.length * WHERES.length);
  for (const {input, runs, where, state} of rows) {
    const reason = state.is === 'verified' ? state.by : state.is === 'unimplemented' ? state.needs : state.why;
    assert.ok(reason.length > 10, `${input} on ${runs}, ${where}: ${state.is} with no reason`);
  }
});

test('what is verified names a check this repository has', () => {
  const checks = new Set(targets().flatMap(({state}) => (state.is === 'verified' ? [state.by] : [])));
  assert.ok(checks.size > 0);
  for (const check of checks) assert.ok(existsSync(new URL(check, root)), `${check} is not there`);
});

test('all nine pairs of instruction sets are in the goal: none is excluded on every host', () => {
  for (const input of ISAS) for (const runs of ISAS) {
    assert.ok(WHERES.some((where) => target(input, runs, where).is !== 'excluded'), `${input} on ${runs}`);
  }
});

test('what cannot be is told apart from what is not made, and from what is not checked', () => {
  assert.equal(target('x86-64', 'x86-64', 'linux').is, 'verified');
  assert.equal(target('x86-64', 'arm64', 'linux').is, 'unverified'); // (a Raspberry Pi: the same wasm, no check there)
  assert.equal(target('arm64', 'arm64', 'linux').is, 'unimplemented');
  assert.equal(target('x86-64', 'x86-64', 'bare').is, 'unimplemented');
  assert.equal(target('arm64', 'riscv64', 'macos').is, 'excluded'); // (excluded before it is called not made)
});

test("README.md's tables are these", () => {
  const readme = readFileSync(new URL('module/sods/README.md', root), 'utf8');
  assert.ok(readme.includes(table()), 'node module/sods/runtime/targets.ts prints the table README.md is to have');
  assert.ok(readme.includes(owedTable()), 'node module/sods/runtime/targets.ts --one prints the tables README.md is to have');
});
