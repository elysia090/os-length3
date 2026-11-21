// A prepared package cache and archive reader shared by the neutral and product assembly tests.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

export function packageCache() {
  const at = mkdtempSync(join(tmpdir(), 'ricebox-root-test-')), pkgs = join(at, 'packages');
  mkdirSync(pkgs);
  const add = (name: string, files: Record<string, string>) => {
    const dir = join(pkgs, name); mkdirSync(dir);
    for (const [path, value] of Object.entries(files)) {
      const to = join(dir, 'tree', path); mkdirSync(dirname(to), {recursive: true}); writeFileSync(to, value);
    }
    for (const [file, value] of [['version', '1.0'], ['source', name + '-source'], ['key', name + '-key']]) writeFileSync(join(dir, file), value);
  };
  add('base', {'usr/bin/tool': 'a neutral tool\n'});
  return {at, pkgs, add};
}

export function readArchive(archive: string, path: string) {
  const r = spawnSync('tar', ['--zstd', '-xOf', archive, path], {encoding: 'utf8'});
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
