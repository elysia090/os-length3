// Source references used by the workspace's ownership and layer checks.
// Preserve quoted strings but skip comments. Templates stay opaque: a computed import must not conceal an edge.
function tokens(source: string): string[] {
  return [...source.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\w$]+|[^\s]/g)]
    .map(m => m[0]).filter(t => !t.startsWith('//') && !t.startsWith('/*'));
}
const quoted = (token: string | undefined) => token !== undefined && (token[0] === "'" || token[0] === '"');

/** Literal imports, re-exports (types included), and source URLs used by Worker constructors. */
export function references(source: string): string[] {
  const ts = tokens(source), found: string[] = [];
  const add = (token: string | undefined) => {
    if (!quoted(token) || token!.includes('\\')) { found.push('<computed or escaped module reference>'); return; }
    found.push(token!.slice(1, -1));
  };
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (t?.startsWith('`') && /\b(?:import|require)\s*\(|\bnew\s+(?:Worker|SharedWorker|NodeWorker)\s*\(/.test(t)) {
      found.push('<code dependency inside template>');
      continue;
    }
    if (t === 'import' && ts.slice(i + 1, i + 4).join('') === '.meta.' && /^glob/.test(ts[i + 4] ?? '')) {
      found.push('<bundler glob dependency>');
      continue;
    }
    if ((t === 'import' || t === 'require') && ts[i - 1] !== '.' && ts[i + 1] === '(') {
      if (ts[i + 3] !== ')' && ts[i + 3] !== ',') found.push('<computed module reference>');
      else add(ts[i + 2]);
    } else if ((t === 'import' || (t === 'export' && (['{', '*'].includes(ts[i + 1] ?? '') || (ts[i + 1] === 'type' && ['{', '*'].includes(ts[i + 2] ?? ''))))) && ts[i - 1] !== '.' && ts[i + 1] !== '.') {
      if (quoted(ts[i + 1])) add(ts[i + 1]);
      else for (let j = i + 1; j < ts.length && ts[j] !== ';'; j++) {
        if (ts[j] === 'from') { add(ts[j + 1]); break; }
        if (j > i + 1 && (ts[j] === 'import' || ts[j] === 'export')) break;
      }
    } else if (t === 'new' && ['Worker', 'SharedWorker', 'NodeWorker'].includes(ts[i + 1] ?? '') && ts[i + 2] === '(') {
      // Worker URLs are code, unlike ordinary distribution/pack URLs. A computed code source needs an
      // explicit adapter contract and corresponding check; do not silently let it bypass the graph.
      if (quoted(ts[i + 3]) && [',', ')'].includes(ts[i + 4] ?? '')) add(ts[i + 3]);
      else if (ts[i + 3] === 'new' && ts[i + 4] === 'URL' && ts[i + 5] === '(' && quoted(ts[i + 6]) && ts[i + 7] === ',') add(ts[i + 6]);
      else if (ts.slice(i + 3, i + 12).join('') !== 'newURL(import.meta.url)') found.push('<computed worker source>');
    } else if (t === 'new' && ts[i + 1] === 'URL' && ts[i + 2] === '(' && quoted(ts[i + 3]) && /\.[cm]?[jt]s(?:[?#][^"']*)?["']$/.test(ts[i + 3]!)) {
      add(ts[i + 3]);
    }
  }
  return [...new Set(found)];
}

/** Relative module dependencies, with bundler queries and URL fragments removed. */
export function relativeReferences(source: string): string[] {
  return references(source)
    .filter(reference => reference.startsWith('./') || reference.startsWith('../'))
    .map(reference => reference.split(/[?#]/)[0]!);
}
