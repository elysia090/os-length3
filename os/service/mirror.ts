// Puts a release's files on the Remote, since only the Remote can hand them to
// anyone: the GitHub repository they are published in is private, and GitHub
// holds no Cloudflare credentials. The deploy (deploy.ts) runs it after the
// Worker answers, for what this tree pins (releases.ts): every root in
// core/src/root.rs RELEASES, and the desktop app of the version RELEASE
// names. One the Remote recorded as put at its pinned digest and size
// (release_file, written only once the put is done) is kept as it is. Otherwise the file is taken from the GitHub release with the read-only
// GITHUB_TOKEN, streamed to a file while its digest is taken, and put into
// the bucket only when it is the digest and size this tree pins. Nothing is
// put that was not checked; running it again changes nothing.

import {createHash} from 'node:crypto';
import {createWriteStream, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Pinned} from './releases.ts';

/**
 * Where the files go: whether the Remote has a file as pinned (its digest and size recorded when it was put:
 * release_file), and putting a checked file under its key, recorded with what it cost once it is in.
 */
export interface Store {
  has(p: Pinned): Promise<boolean>;
  put(p: Pinned, file: string): Promise<void>;
}

interface Source {
  /** The GitHub API (https://api.github.com), the repository (owner/name) and a token that can read its releases. */
  api: string;
  repo: string;
  token?: string;
  fetch?: typeof fetch;
}

/** One file of a GitHub release, as a response whose body is still to be read. */
async function asset(s: Source, p: Pinned): Promise<Response> {
  const f = s.fetch ?? fetch;
  // Never waited on for good (a download that stalls holds the deploy until the build is killed): ten minutes, its body included.
  const ask = (path: string, accept: string) => f(`${s.api}/repos/${s.repo}${path}`, {
    headers: {accept, 'x-github-api-version': '2022-11-28', 'user-agent': 'length3-deploy', ...(s.token ? {authorization: `Bearer ${s.token}`} : {})},
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const must = async (r: Response, what: string) => {
    if (r.ok) return r;
    await r.body?.cancel();
    throw new Error(`${what}: ${r.status}${r.status === 404 && !s.token ? ' (a private repository needs GITHUB_TOKEN)' : ''}`);
  };
  const release = await (await must(await ask(`/releases/tags/${p.tag}`, 'application/vnd.github+json'), `the release ${p.tag}`)).json() as {assets: {id: number; name: string}[]};
  const a = release.assets.find((x) => x.name === p.file);
  if (!a) throw new Error(`${p.tag} has no ${p.file}`);
  // The API answers with where the bytes are; fetch follows it there, and leaves the token behind (another origin).
  return must(await ask(`/releases/assets/${a.id}`, 'application/octet-stream'), p.file);
}

/** The body into `file`, never more than `most` bytes; its sha256 and length. */
async function keep(r: Response, file: string, most: number): Promise<{sha256: string; bytes: number}> {
  const hash = createHash('sha256'), out = createWriteStream(file);
  let bytes = 0;
  try {
    for await (const chunk of (r.body ?? []) as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.length;
      if (bytes > most) throw new Error(`more than the ${most} bytes pinned`);
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((go) => out.once('drain', () => go()));
    }
  } finally {
    await new Promise<void>((done, failed) => out.end((e?: Error | null) => (e ? failed(e) : done())));
  }
  return {sha256: hash.digest('hex'), bytes};
}

/**
 * Each pinned file the Remote has at its pinned size is kept; each other one is
 * taken, checked and put. All are tried; what failed is said together at the end.
 */
export async function mirror(pins: Pinned[], store: Store, source: Source, log: (line: string) => void = console.log,
  /** Asked before a file is taken and put: throws when the budget has no room for it (deploy.ts). */
  allow: (p: Pinned) => Promise<void> = async () => {}): Promise<{kept: string[]; put: string[]}> {
  const kept: string[] = [], put: string[] = [], failed: string[] = [];
  const work = mkdtempSync(join(tmpdir(), 'length3-mirror-'));
  try {
    for (const p of pins) {
      try {
        if (await store.has(p)) { kept.push(p.key); continue; }
        // Asked before anything is fetched or put: R2's puts and the bytes it holds are the Worker's budget too.
        await allow(p);
        const file = join(work, p.sha256);
        const got = await keep(await asset(source, p), file, p.bytes);
        if (got.sha256 !== p.sha256 || got.bytes !== p.bytes)
          throw new Error(`${p.file} from ${p.tag} is sha256 ${got.sha256} (${got.bytes} bytes); this tree pins ${p.sha256} (${p.bytes} bytes)`);
        await store.put(p, file);
        rmSync(file, {force: true});
        put.push(p.key);
        log(`${p.key}: put (${p.file}, ${p.bytes} bytes)`);
      } catch (e) {
        failed.push(`${p.key}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    rmSync(work, {recursive: true, force: true});
  }
  if (failed.length) throw new Error(`release files not on the Remote:\n  ${failed.join('\n  ')}`);
  return {kept, put};
}
