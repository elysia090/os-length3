// Native filesystem inventory. It reads directories or the native release archive.
import {lstatSync,readFileSync,readdirSync,readlinkSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {byPath, type Entry, type Tree} from '../../distribution/inventory.ts';
import {sha256} from './hash.ts';
import {readTarball} from './tar.ts';

/** An installed root, walked as the host has it. */
export function readDir(root: string): Tree {
  const entries: Entry[] = [];
  (function walk(dir: string, rel: string) {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name), path = `${rel}/${name}`, st = lstatSync(full);
      if (st.isSymbolicLink()) entries.push({path, type: 'link', mode: 0o777, target: readlinkSync(full)});
      else if (st.isDirectory()) { entries.push({path, type: 'dir', mode: st.mode & 0o7777}); walk(full, path); }
      else if (st.isFile()) entries.push({path, type: 'file', mode: st.mode & 0o7777, size: st.size, sha256: sha256(readFileSync(full))});
      else entries.push({path, type: 'other', mode: st.mode & 0o7777});
    }
  })(root, '');
  entries.sort(byPath);
  return {entries};
}

export async function nativeTree(at: string): Promise<Tree> {
  return statSync(at).isDirectory() ? readDir(at) : readTarball(at);
}

