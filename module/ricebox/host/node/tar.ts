// Node stream reader for the native release archive and its normalized inventory.
import {createReadStream} from 'node:fs';
import {createZstdDecompress} from 'node:zlib';
import type {Readable} from 'node:stream';
import {byPath, type Entry, type Tree} from '../../distribution/inventory.ts';
import {sha256} from './hash.ts';

/** One member of a tar stream, as why/prompt/roots/pins.rs reads it. */
export interface TarMember { name: string; kind: string; mode: number; link: string; size: number; bytes: Buffer }

/**
 * Every member of a tar stream: {name, kind ('0' file, '5' dir, '2' symlink, '1' hard link), mode, link, size, bytes},
 * with pax path and linkpath applied, as why/prompt/roots/pins.rs reads one.
 */
export async function* tarMembers(stream: Readable): AsyncGenerator<TarMember> {
  // The stream's chunks as they come, and how far into the first one is read: each member is copied out once.
  const chunks: Buffer[] = [];
  let have = 0, skip = 0, done = false;
  const it: AsyncIterator<Buffer> = stream[Symbol.asyncIterator]();
  const take = async (n: number) => {
    while (have < n && !done) {
      const r = await it.next();
      if (r.done) done = true;
      else { chunks.push(r.value); have += r.value.length; }
    }
    if (have < n) throw new Error('tar: cut short');
    const out = Buffer.allocUnsafe(n);
    let at = 0;
    while (at < n) {
      const c = chunks[0];
      const k = Math.min(c.length - skip, n - at);
      c.copy(out, at, skip, skip + k);
      at += k; skip += k;
      if (skip === c.length) { chunks.shift(); skip = 0; }
    }
    have -= n;
    return out;
  };
  const octal = (b: Buffer) => { const t = b.toString('latin1').replace(/\0.*$/s, '').trim(); return t ? parseInt(t, 8) : 0; };
  const text = (b: Buffer) => b.toString('utf8').replace(/\0.*$/s, '');
  let longName: string | null = null, longLink: string | null = null;
  for (;;) {
    const block = await take(512);
    if (block.every((b) => b === 0)) return;
    const size = octal(block.subarray(124, 136));
    const kind = String.fromCharCode(block[156] || 0x30);
    let name = text(block.subarray(0, 100));
    if (block.subarray(257, 262).toString('latin1') === 'ustar' && block[345]) name = `${text(block.subarray(345, 500))}/${name}`;
    const padded = Math.ceil(size / 512) * 512;
    const body = (await take(padded)).subarray(0, size);
    if (kind === 'x' || kind === 'g') {
      if (kind === 'x') {
        let rest = body;
        while (rest.length) {
          const sp = rest.indexOf(0x20);
          const len = parseInt(rest.subarray(0, sp).toString('latin1'), 10);
          const record = rest.subarray(sp + 1, len - 1).toString('utf8');
          if (record.startsWith('path=')) longName = record.slice(5);
          if (record.startsWith('linkpath=')) longLink = record.slice(9);
          rest = rest.subarray(len);
        }
      }
      continue;
    }
    yield {name: longName ?? name, kind: kind === '7' ? '0' : kind, mode: octal(block.subarray(100, 108)) & 0o7777,
      link: longLink ?? text(block.subarray(157, 257)), size, bytes: body};
    longName = longLink = null;
  }
}

/** A member's place in the root: '/usr/bin/sh' for root/usr/bin/sh; null for what is beside the root (manifest) or the root itself. */
const inRoot = (name: string) => {
  const parts = name.split('/').filter((p) => p && p !== '.');
  if (parts[0] !== 'root' || parts.length < 2) return null;
  if (parts.some((p) => p === '..')) throw new Error(`tar: ${name} leaves the tree`);
  return `/${parts.slice(1).join('/')}`;
};

/**
 * The root in a release tarball, as why installs it, and its manifest file:
 * {entries, manifest}. `each(entry, bytes)` sees every file's bytes once
 * (module/ricebox/make/layers.ts packs them from here).
 */
export async function readTarball(file: string, each: (entry: Entry, bytes: Buffer | null) => void = () => {}): Promise<Tree> {
  const entries: Entry[] = [];
  const files = new Map<string, Entry>();
  let manifest = '';
  const stream = createReadStream(file).pipe(createZstdDecompress());
  for await (const m of tarMembers(stream)) {
    if (m.name.replace(/^\.\//, '') === 'manifest') { manifest = m.bytes.toString('utf8'); continue; }
    const path = inRoot(m.name);
    if (!path) continue;
    if (m.kind === '5') entries.push({path, type: 'dir', mode: m.mode | 0o700});
    else if (m.kind === '2') entries.push({path, type: 'link', mode: 0o777, target: m.link});
    else if (m.kind === '0') {
      const e: Entry = {path, type: 'file', mode: m.mode & 0o777, size: m.size, sha256: sha256(m.bytes)};
      files.set(path, e);
      entries.push(e);
      each(e, m.bytes);
    } else if (m.kind === '1') {
      const to = files.get(inRoot(m.link) ?? '');
      if (!to) throw new Error(`tar: ${m.name} links to ${m.link}, which is not a file before it`);
      // One file with two names: its mode is the file's.
      const e: Entry = {...to, path, same: to.path};
      entries.push(e);
      each(e, null);
    } else throw new Error(`tar: ${m.name}: kind ${m.kind} is not part of a root`);
  }
  entries.sort(byPath);
  return {entries, manifest};
}

