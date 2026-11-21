import assert from 'node:assert/strict';
import test from 'node:test';
import {linuxSandboxReport} from './stock-chrome.ts';

const layers = [['PID namespaces', 'Yes'], ['Network namespaces', 'Yes'],
  ['Seccomp-BPF sandbox', 'Yes']] as const;

test('recognized reports require active namespace and seccomp isolation', () => {
  assert.equal(linuxSandboxReport([['Layer 1 Sandbox', 'Namespace'], ...layers]).layer, 'Namespace');
  assert.equal(linuxSandboxReport([['Layer 1 Sandbox', 'SUID'], ...layers]).layer, 'SUID');
  assert.equal(linuxSandboxReport([['Namespace Sandbox', 'Yes'], ['SUID Sandbox', 'No'], ...layers]).layer, 'Namespace');
  assert.equal(linuxSandboxReport([['Namespace Sandbox', 'No'], ['SUID Sandbox', 'Yes'], ...layers]).layer, 'SUID');
});

test('missing or contradictory report is not sandbox proof', () => {
  assert.throws(() => linuxSandboxReport([['Layer 1 Sandbox', 'None'], ['SUID Sandbox', 'Yes'], ...layers]), /unavailable/);
  assert.throws(() => linuxSandboxReport([['Layer 1 Sandbox', 'Namespace'], ...layers.slice(0, -1)]), /unavailable/);
  assert.throws(() => linuxSandboxReport([['Layer 1 Sandbox', 'Namespace'], ['PID namespaces', 'No'], ...layers.slice(1)]), /unavailable/);
  assert.throws(() => linuxSandboxReport([['Layer 1 Sandbox', 'Namespace'], ...layers, ['PID namespaces', 'No']]), /Ambiguous/);
});
