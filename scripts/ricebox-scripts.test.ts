import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {checkScripts} from '../ricebox/distribution/build/script-interpreters.ts';

function fixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'ricebox-interpreters-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  const file = (path: string, text: string, mode = 0o755) => {
    mkdirSync(dirname(root + path), {recursive: true}); writeFileSync(root + path, text); chmodSync(root + path, mode);
  };
  const link = (target: string, path: string) => { mkdirSync(dirname(root + path), {recursive: true}); symlinkSync(target, root + path); };
  return {root, file, link};
}
test('language package in assembled root satisfies a script from another package', (t) => {
  const {root,file,link} = fixture(t); file('/usr/bin/python3', 'binary fixture'); link('usr/bin','/bin');
  file('/usr/bin/app', '#!/bin/python3\nprint(42)\n'); assert.deepEqual(checkScripts(root), []);
});
test('missing language does not borrow the build host interpreter', (t) => {
  const {root,file} = fixture(t); file('/usr/bin/app', '#!/usr/bin/python3\nprint(42)\n');
  assert.equal(checkScripts(root).length, 1);
});
test('a familiar basename does not excuse a missing absolute path', (t) => {
  const {root,file} = fixture(t); file('/usr/bin/sh', 'binary fixture'); file('/usr/bin/app', '#!/missing/sh\necho 42\n');
  assert.equal(checkScripts(root).length, 1);
});
test('absolute symlinks resolve in root, including interpreter chains', (t) => {
  const {root,file,link} = fixture(t); file('/usr/bin/python3', 'binary fixture');
  link('/usr/bin/python3','/usr/bin/python'); file('/usr/bin/app', '#!/usr/bin/python\n');
  assert.deepEqual(checkScripts(root), []);
});
test('relative symlinks resolve from their directory, not the host', (t) => {
  const {root,file,link} = fixture(t); file('/opt/python/bin/python3','binary fixture');
  link('../../opt/python/bin/python3','/usr/bin/python3'); file('/usr/bin/app','#!/usr/bin/python3\n');
  assert.deepEqual(checkScripts(root), []);
});
test('broken interpreter symlink fails even when its name is sh', (t) => {
  const {root,file,link} = fixture(t); link('/not-in-root/sh','/usr/bin/sh'); file('/usr/bin/app','#!/usr/bin/sh\n');
  assert.equal(checkScripts(root).length, 1);
});
test('broken symlinks and symlink cycles fail', (t) => {
  const {root,file,link} = fixture(t); link('/usr/bin/b','/usr/bin/a'); link('/usr/bin/a','/usr/bin/b');
  file('/usr/bin/app', '#!/usr/bin/a\n'); assert.match(checkScripts(root).join('\n'), /symlink loop/);
});
test('nonexecutable interpreter fails', (t) => {
  const {root,file} = fixture(t); file('/usr/bin/python3', 'binary fixture', 0o644); file('/usr/bin/app', '#!/usr/bin/python3\n');
  assert.match(checkScripts(root).join('\n'), /not an executable/);
});
test('env is required, and its command is resolved only in root PATH', (t) => {
  const {root,file} = fixture(t); file('/usr/bin/python3', 'binary fixture'); file('/usr/bin/app', '#!/usr/bin/env python3\n');
  assert.equal(checkScripts(root).length, 1); file('/usr/bin/env','binary fixture'); assert.deepEqual(checkScripts(root), []);
});
test('env -S accepts a quoted command and options', (t) => {
  const {root,file} = fixture(t); file('/usr/bin/env','binary fixture'); file('/usr/bin/python3','binary fixture');
  file('/usr/bin/app', '#!/usr/bin/env -S "python3" -I\n'); assert.deepEqual(checkScripts(root), []);
});
test('env without -S receives a single argument, not shell splitting', (t) => {
  const {root,file} = fixture(t); file('/usr/bin/env','binary fixture'); file('/usr/bin/python3','binary fixture');
  file('/usr/bin/app', '#!/usr/bin/env python3 -I\n'); assert.match(checkScripts(root).join('\n'), /absent/);
});
test('recursive script interpreters and CRLF shebangs fail', (t) => {
  const {root,file} = fixture(t); file('/usr/bin/a','#!/usr/bin/b\n'); file('/usr/bin/b','#!/usr/bin/a\n');
  assert.ok(checkScripts(root).every((e) => e.includes('interpreter cycle')));
  file('/usr/bin/a','#!/usr/bin/b\r\n'); assert.ok(checkScripts(root).some((e) => e.includes('carriage return')));
});
test('inactive sample hooks and nonexecutable source files are not runtime requirements', (t) => {
  const {root,file} = fixture(t); file('/hooks/precommit.sample','#!/missing/perl\n'); file('/source.py','#!/missing/python\n',0o644);
  assert.deepEqual(checkScripts(root), []);
});
