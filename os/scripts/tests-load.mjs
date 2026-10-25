// For npm test (scripts/tests.mjs): how each test process loads its modules, loaded before any of them. A test
// process loads the same modules each run, and most of a short one's time went on loading them again:
//
// - TypeScript: each .ts module's types stripped once, and the result kept in the temporary directory under its
//   address and its text; a process whose modules are all kept never loads the stripper (amaro, a compiler in
//   WebAssembly), which with the stripping was more than half of a short test file's 0.5 s. What is kept is what
//   node makes of the module itself (the same call, the same sourceURL line), so the module is the same.
// - Compiling: V8's code for each module kept on disk for the next process (node's own compile cache).
// - Finding a package's modules: node 22 reads a package's whole package.json again for every module of it that
//   it resolves, to learn the package's "type"; drizzle-orm's is 180 KB, read for each of its 200 modules, half a
//   second of loading the service. A relative import of a .js module in such a package is resolved here as node
//   resolves it, the package's "type" read once; and a package asked for again from the same folder is where
//   node found it the first time.
//
// Not a module of the tests: a plain .mjs, so that loading it needs nothing it makes faster.

import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {enableCompileCache, registerHooks, stripTypeScriptTypes} from 'node:module';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

enableCompileCache();

/** Where stripped modules are kept, apart for each node (each strips with its own amaro). */
const STRIPPED = join(tmpdir(), `length3-ts-${process.version}`);
mkdirSync(STRIPPED, {recursive: true});

/** A .ts module's text without its types, as node's loader makes it: kept from before, or made and kept. */
function stripped(url, text) {
  const kept = join(STRIPPED, `${createHash('sha256').update(url).update('\0').update(text).digest('hex')}.js`);
  try {
    return readFileSync(kept, 'utf8');
  } catch {
    // Made below.
  }
  // The same call node's loader makes (internal/modules/typescript), less its warning that the call is new.
  const warn = process.emitWarning;
  process.emitWarning = () => {};
  let code;
  try {
    code = stripTypeScriptTypes(text, {mode: 'strip', sourceUrl: url});
  } finally {
    process.emitWarning = warn;
  }
  // Written aside, then named: a process reading it never meets half of it.
  const aside = `${kept}.${process.pid}`;
  writeFileSync(aside, code);
  renameSync(aside, kept);
  return code;
}

/** The "type" of the package.json nearest above a folder, as node finds it (null: none says), each read once. */
const types = new Map();
function typeAt(dir) {
  if (types.has(dir)) return types.get(dir);
  let type = null;
  try {
    type = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).type ?? null;
  } catch (e) {
    // None here: the folder above's, but never past a node_modules folder, where node stops looking.
    if (e.code === 'ENOENT' && basename(dir) !== 'node_modules' && dirname(dir) !== dir) type = typeAt(dirname(dir));
  }
  types.set(dir, type);
  return type;
}

/** A package (or a module of one) as node found it for a folder asking: any module of that folder finds the same. */
const found = new Map();

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL;
    if (/^[@\w]/.test(specifier) && !specifier.includes(':') && parent?.startsWith('file:')) {
      const key = [specifier, new URL('.', parent).href, context.conditions?.join(), JSON.stringify(context.importAttributes ?? {})].join('\0');
      const was = found.get(key);
      if (was) return {...was, shortCircuit: true};
      const r = nextResolve(specifier, context);
      found.set(key, r);
      return {...r};
    }
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js') && parent?.startsWith('file:')
      && parent.includes('/node_modules/') && !parent.includes('?') && context.conditions?.includes('import')) {
      const path = fileURLToPath(new URL(specifier, parent));
      // As node's own: a file that is there, by its real path, a module when its package says so. Anything
      // else (missing, a folder, not "type": "module") is node's to resolve, and to refuse.
      if (typeAt(dirname(path)) === 'module' && statSync(path, {throwIfNoEntry: false})?.isFile()) {
        return {url: pathToFileURL(realpathSync.native(path)).href, format: 'module', shortCircuit: true};
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (context.format === 'module-typescript' && url.startsWith('file:') && !url.includes('/node_modules/')) {
      // Read as node reads it: UTF-8, a byte-order mark dropped.
      const text = new TextDecoder().decode(readFileSync(fileURLToPath(url)));
      return {format: 'module', source: stripped(url, text), shortCircuit: true};
    }
    return nextLoad(url, context);
  },
});
