// Decode and check a complete prepared distribution for comparison with a native root.
import {byPath,type Entry,type Tree} from '../distribution/inventory.ts';
import {sha256} from '../host/node/hash.ts';
import {openDistribution} from './local.ts';

/** Every path of the web root, each file's bytes decoded from its pack and hashed; and each pack checked whole. */
export function webTree(dir: string): Tree {
  const web = openDistribution(dir);
  const {index} = web;
  try {
    web.checkAll();
    const entries: Entry[] = [
      ...index.dirs.map((d): Entry => ({path: d.path, type: 'dir', mode: d.mode})),
      ...index.links.map((l): Entry => ({path: l.path, type: 'link', mode: 0o777, target: l.target})),
      ...index.files.map((f): Entry => {
        const bytes = web.read(f);
        if (bytes.length !== f.size) throw new Error(`${f.path}: ${bytes.length} bytes from its pack, its index says ${f.size}`);
        return {path: f.path, type: 'file', mode: f.mode, size: f.size, sha256: sha256(bytes)};
      }),
    ];
    entries.sort(byPath);
    // What a page gives its Prompt beside the packs (a hot program with its translation) is the same file, byte for byte.
    const at = new Map(entries.map((e) => [e.path, e]));
    for (const t of index.translations ?? []) {
      const elf = sha256(web.blob(t.elf));
      web.blob(t.wasm);
      if (elf !== t.sha256 || at.get(t.path)?.sha256 !== elf) throw new Error(`${t.elf.path}: sha256 ${elf}, not ${t.path} of the root (${at.get(t.path)?.sha256 ?? 'none'})`);
    }
    return {entries, about: web.about, index};
  } finally { web.close(); }
}

