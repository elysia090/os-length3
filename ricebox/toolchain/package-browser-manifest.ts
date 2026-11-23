// Invoked by the package compiler with Node's ESM parser, on emitted JavaScript.
// This is build tooling; it is not installed or run by the site-staging helper.
import {readFileSync, writeFileSync} from 'node:fs';
import {join, posix} from 'node:path';
import {SourceTextModule} from 'node:vm';

const [out, coreEntry, displayEntry] = process.argv.slice(2);

function workerURLs(source: string, path: string): string[] {
  // Packaged browser code uses direct literal module Worker URLs; don't
  // silently guess a URL for qualified, bracketed, or aliased constructors.
  const direct = /\bnew\s+Worker\s*\(\s*new\s+URL\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)\s*,\s*\{\s*type:\s*['"]module['"]\s*,?\s*\}\s*\)/g;
  const urls = [...source.matchAll(direct)].map(match => match[2]);
  let rest = source.replace(direct, '');

  // Allow the existing feature probe and the explicitly guarded Node adapter.
  const probe = 'if (going || typeof Worker !== \'function\') return;';
  const nodeAdapter = 'const NodeWorker = (await nodeThreads())?.Worker ?? null;';
  if (path === 'distribution/runtime/pretranslate.js' || path === 'sods/runtime/linux/remote.js') {
    const allowed = path === 'distribution/runtime/pretranslate.js' ? probe : nodeAdapter;
    rest = rest.split('\n').filter(line => line.trim() !== allowed).join('\n');
  }

  // Inert multiword diagnostic literals are not constructor references. Do
  // not strip arbitrary strings or exclude code inside template expressions.
  rest = rest.replace(/(\bnew (?:Error\(\s*|AggregateError\(\s*[\w$]+\s*,\s*)|^[\t ]*error:\s*)(['"])([^'"\n]+)\2(?=\s*[,)}])/gm,
    (whole: string, context: string, _quote: string, words: string) => words.includes(' ') ? context : whole);
  // This is a source convention, not data-flow analysis: computing a global
  // name that doesn't spell Worker (for example, from inputs) is unsupported.
  if (/\b(?:Worker|SharedWorker)\b/.test(rest)) {
    throw new Error(`ricebox: unsupported Worker reference in ${path}; use a direct literal module Worker URL`);
  }
  return urls;
}

function closure(entry: string): string[] {
  const files = new Set<string>();
  function visit(path: string): void {
    if (files.has(path)) return;
    if (!/^(?:distribution\/(?:format|runtime)|sods\/runtime|everyday\/src)(?:\/[a-z0-9-]+)*\/[a-z0-9.-]+\.js$/.test(path)) {
      throw new Error(`ricebox: unexpected browser module ${path}`);
    }
    files.add(path);
    const source = readFileSync(join(out, 'ricebox', path), 'utf8');
    const follow = (specifier: string): void => {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new Error(`ricebox: non-relative browser module ${specifier} in ${path}`);
      visit(posix.join(posix.dirname(path), specifier));
    };
    const module = new SourceTextModule(source, {identifier: path});
    // Older Node 24 builds call this dependencySpecifiers.
    for (const specifier of module.moduleRequests?.map(request => request.specifier) ?? module.dependencySpecifiers) follow(specifier);

    const imports = [...source.matchAll(/\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g)];
    if (imports.length !== [...source.matchAll(/\bimport\s*\(/g)].length) {
      throw new Error(`ricebox: untracked import in ${path}`);
    }
    for (const specifier of workerURLs(source, path)) follow(specifier);
    for (const [, , specifier] of imports) {
      // host.ts alone can select Node's Worker API; that branch is not a browser URL.
      if (path === 'sods/runtime/host.js' && specifier === 'node:worker_threads') continue;
      follow(specifier);
    }
  }
  visit(entry);
  return [...files].sort();
}

const core = closure(coreEntry), display = closure(displayEntry).filter(path => !core.includes(path));
writeFileSync(join(out, 'ricebox/distribution/deployment/browser-modules.json'), JSON.stringify({v: 1, core, display}) + '\n', {flag: 'wx'});
