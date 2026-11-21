import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startMessage} from './terminal.ts';
import {executionRoot, type Box, type PreparedRoot} from '../../../prompt/userland.ts';

const module = new WebAssembly.Module(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0));
const executable = {
  generation: 'generation-a', key: 'generation-a:source:artifact', path: '/usr/bin/program',
  source: {origin: 'canonical-origin', sha256: 'source', size: 4096, binding: 'explicit' as const},
  artifact: {sha256: 'artifact', translator: 'translator', mode: 'whole' as const},
  module, segments: null, shared: false,
};
const root = {
  profile: 'canonical-aot-v1', generation: 'generation-a', executables: [executable],
  url: 'https://root.test/', index: {}, translator: module, muk: null,
} as PreparedRoot;
const file = {path: '/root/repo/readme', bytes: Uint8Array.of(1, 2, 3), mode: 0o644};
const copy = {files: [file], dirs: [], complete: true};
const box = {} as Box;

test('fresh prepared start sends canonical identity separately from ordinary byte-bearing overlays', (t) => {
  t.mock.method(executionRoot, 'executablesNow', () => root.executables);
  const start = startMessage('repo', root, copy, null, box, null);
  assert.equal(start.profile, root.profile);
  assert.equal(start.generation, root.generation);
  assert.deepEqual(start.executables, [executable]);
  assert.deepEqual(start.files, [file]);
  assert.deepEqual(start.root, {index: root.index, url: root.url});
  assert.equal(start.translator, module);
  assert.equal(start.cwd, '/root/repo');
});

test('rehearsed start deduplicates executable keys, never executable or overlay paths', (t) => {
  t.mock.method(executionRoot, 'executablesNow', () => root.executables);
  const pathOnly = startMessage('repo', root, copy, null, box, new Set([executable.path, file.path]));
  assert.deepEqual(pathOnly.executables, [executable]);
  assert.deepEqual(pathOnly.files, [file]);
  assert.equal('root' in pathOnly, false);
  const prepared = startMessage('repo', root, copy, null, box, new Set([executable.key]));
  assert.deepEqual(prepared.executables, []);
  assert.deepEqual(prepared.files, [file]);
  assert.equal(prepared.profile, root.profile);
  assert.equal(prepared.generation, root.generation);
});
