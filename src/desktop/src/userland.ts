import {download, Fatal} from './fetch.ts';

// l3, the one thing the Prompt depends on: the distribution's root, the l3
// command and the translator, in one file (scripts/bundle.mjs). l3.json
// names it by size and digest. It is the OS, and its canonical copy is the
// release: nothing here is kept of it. In a browser it is fetched by itself
// at each visit's first Prompt (taken up again where a proxy cut it); in the
// app it comes with the app and is read from beside it. Either way it is
// checked against its digest, then unpacked and compiled once per page. Every Prompt's worker gets the same compiled
// modules: a Module is shared, not copied.

export interface About {
  name: string; version: string;
  root: {name: string; version: string; profile: string};
  base: {name: string; version: string; from: string; sha256: string; applets: number};
  translator: {name: string; version: string};
  l3: {sha256: string};
  bundle: {path: string; size: number; bytes: number; sha256: string};
}

interface Entry { path: string; mode: number; at: number; size: number; translation?: {at: number; size: number} }
interface Index {
  translator: {at: number; size: number};
  files: Entry[]; dirs: string[]; links: {path: string; target: string}[];
}

export interface Userland {
  about: About;
  translator: WebAssembly.Module;
  files: {path: string; bytes: Uint8Array; module: WebAssembly.Module | null; mode: number}[];
  dirs: string[];
  links: {path: string; target: string}[];
}

/** Where loading is, for whoever is waiting on it. */
export type Stage =
  | {at: 'fetch'; got: number; of: number; quiet?: number}
  | {at: 'retry'; attempt: number; why: string; got: number; of: number}
  | {at: 'prepare'}
  | {at: 'ready'}
  | {at: 'failed'; message: string};

const HEAD = 12;

/** The bundle's index and its bytes, from the gzip'd file. */
export async function unpack(packed: Uint8Array): Promise<{index: Index & Record<string, unknown>; bytes: Uint8Array}> {
  const stream = new Blob([packed as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  if (new TextDecoder().decode(raw.subarray(0, 8)) !== 'L3BUNDLE') throw new Fatal('l3: not a bundle');
  const length = new DataView(raw.buffer, raw.byteOffset).getUint32(8, true);
  const index = JSON.parse(new TextDecoder().decode(raw.subarray(HEAD, HEAD + length)));
  return {index, bytes: raw.subarray(HEAD + length)};
}

const watchers = new Set<(s: Stage) => void>();
let last: Stage = {at: 'prepare'};
const tell = (s: Stage) => { last = s; for (const w of watchers) w(s); };

/** Hear where loading is (at once, then as it moves); returns how to stop. */
export function watchLoad(fn: (s: Stage) => void): () => void {
  watchers.add(fn);
  fn(last);
  return () => watchers.delete(fn);
}

export const about = (): Promise<About | null> =>
  fetch('/userland/l3.json', {cache: 'no-store'}).then((r) => (r.ok ? r.json() as Promise<About> : null)).catch(() => null);

let loading: Promise<Userland> | null = null;
export const loadUserland = (): Promise<Userland> => (loading ??= (async () => {
  const a = await download('/userland/l3.json', {}, undefined, {attempts: 4}).then((b) => JSON.parse(new TextDecoder().decode(b)) as About);
  const {size, sha256} = a.bundle;
  tell({at: 'fetch', got: 0, of: size});
  let got = 0;
  const packed = await download(`/userland/${a.bundle.path}`, {size, sha256}, {
    bytes(n) { got = n; tell({at: 'fetch', got: n, of: size}); },
    retry(attempt, why) { tell({at: 'retry', attempt, why, got, of: size}); },
    waiting(quiet) { tell({at: 'fetch', got, of: size, quiet}); },
  });
  tell({at: 'prepare'});
  const {index, bytes} = await unpack(packed);
  const slice = (p: {at: number; size: number}) => bytes.slice(p.at, p.at + p.size);
  const [translator, ...modules] = await Promise.all([
    WebAssembly.compile(slice(index.translator) as BufferSource),
    ...index.files.map((f) => (f.translation ? WebAssembly.compile(slice(f.translation) as BufferSource).catch(() => null) : null)),
  ]);
  const files = index.files.map((f, k) => ({path: f.path, bytes: slice(f), module: modules[k], mode: f.mode}));
  tell({at: 'ready'});
  return {about: a, translator, files, dirs: index.dirs, links: index.links};
})().catch((e) => {
  loading = null;
  tell({at: 'failed', message: e instanceof Error ? e.message : String(e)});
  throw e;
}));
