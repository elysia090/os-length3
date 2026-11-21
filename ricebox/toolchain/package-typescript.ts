// Build-time package compilation. Callers own entry points, allowed paths,
// package metadata and other assets; these compiler tools are not packaged.
import {execFileSync} from 'node:child_process';
import {stripTypeScriptTypes} from 'node:module';
import {readFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve, join, dirname, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

// Node 24 supports transform; older @types/node describes only strip mode.
const transform = stripTypeScriptTypes as (source: string, options: {mode: 'strip' | 'transform'}) => string;

export function packageTypeScript(root: string, out: string, entries: readonly string[], check: (path: string) => void): number {
  const closure = new Map<string, {source: string; javascript: string}>();
  function visit(path: string): void {
    if (closure.has(path)) return;
    check(path);
    const source = readFileSync(join(root, path), 'utf8');
    closure.set(path, {source, javascript: transform(source, {mode: 'transform'})});
    // Includes type dependencies and Node/browser Worker URL literals.
    for (const match of source.matchAll(/['"](\.[^'"\n]+\.ts)['"]/g)) {
      visit(relative(root, resolve(root, dirname(path), match[1])));
    }
  }
  for (const entry of entries) visit(entry);
  for (const [path, {source, javascript}] of closure) {
    const destination = join(out, path);
    mkdirSync(dirname(destination), {recursive: true});
    writeFileSync(destination, source);
    writeFileSync(destination.slice(0, -3) + '.js', javascript.replace(/(['"])(\.[^'"\n]+)\.ts\1/g, '$1$2.js$1'));
  }
  return closure.size;
}

/** Stamp the native browser graph from Ricebox's already emitted JavaScript.
 * Only this compiler phase needs Node's experimental ESM parser enabled. */
export function packageBrowserManifest(out: string, entry: string, display: string): void {
  const webEntry = (path: string) => path.slice('ricebox/'.length).replace(/\.ts$/, '.js');
  const compiler = fileURLToPath(new URL('./package-browser-manifest.mjs', import.meta.url));
  execFileSync(process.execPath, ['--experimental-vm-modules', compiler, out, webEntry(entry), webEntry(display)], {stdio: 'inherit'});
}
