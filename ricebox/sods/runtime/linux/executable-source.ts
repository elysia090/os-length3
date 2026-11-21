// Private source capabilities for a prepared tree. The public token contains no
// inode, path or transferable authority. Its WeakMap value retains the original
// tree/source owner for exactly as long as the prepared owner retains the token.
import {File, Vfs} from './fs.ts';

declare const executableSource: unique symbol;
/** Realm-local identity captured from a canonical tree before overlays. Not a wire value. */
export interface ExecutableSource { readonly [executableSource]: true }
interface Captured { readonly vfs: Vfs; readonly node: File; readonly origin: string; readonly size: number; readonly revision: number }
const sources = new WeakMap<ExecutableSource, Captured>();

/**
 * Capture metadata and the exact inode, never its payload. The caller establishes
 * the trusted release/index/artifact association; origin plus size is not a hash.
 * Symlink spellings are not canonical sources (exec still follows them normally).
 */
export function captureExecutableSource(vfs: Vfs, path: string, expected: {origin: string; size: number}): ExecutableSource {
  if (!(vfs instanceof Vfs) || typeof path !== 'string' || !/^\/(?:[^/\0]+\/)*[^/\0]+$/.test(path)
    || path.split('/').some((part) => part === '.' || part === '..')) throw new TypeError('Expected a canonical executable path');
  if (!expected || typeof expected.origin !== 'string' || !expected.origin
    || !Number.isSafeInteger(expected.size) || expected.size < 0) throw new TypeError('Invalid executable source metadata');
  const {origin, size} = expected;
  // Reject aliases in intermediate components as well as the final component.
  const parts = path.slice(1).split('/');
  for (let i = 1; i < parts.length; i++) if (vfs.lookup('/' + parts.slice(0, i).join('/'), '/', false).isLink)
    throw new TypeError('Executable source path contains a symlink');
  const node = vfs.lookup(path, '/', false);
  if (!(node instanceof File) || !node.isFile) throw new TypeError('Executable source is not a regular file');
  if (node.version !== 0 || node.origin !== origin || node.size !== size) throw new TypeError('Executable source metadata does not match the canonical inode');
  const token = Object.freeze(Object.create(null)) as ExecutableSource;
  sources.set(token, Object.freeze({vfs, node, origin, size, revision: node.version}));
  return token;
}

/** Internal capability admission, before any image/Worker side effects. */
export function executableSourceFor(source: ExecutableSource, vfs: Vfs): Captured {
  const captured = sources.get(source);
  if (!captured) throw new TypeError('Invalid or foreign executable source');
  if (captured.vfs !== vfs) throw new TypeError('Executable source belongs to another Vfs');
  return captured;
}

/** No path re-resolution: a replacement name must never receive the old image. */
export function unchangedExecutableSource(captured: Captured): boolean {
  const {node, origin, size, revision} = captured;
  return node.isFile && node.version === revision && node.origin === origin && node.size === size;
}
