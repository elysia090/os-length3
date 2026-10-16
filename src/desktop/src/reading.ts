/** Reading order inside a directory: README first, the other files, then the directories. */
export function readingOrder<T extends {name: string; kind: string}>(entries: readonly T[]): T[] {
  const rank = (e: T) => (e.kind === 'dir' ? 2 : /^readme(\.|$)/i.test(e.name) ? 0 : 1);
  return [...entries].sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Lines as an editor counts them: a final newline does not start another. */
export function lineCount(text: string): number {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

const KINDS: Record<string, string> = {
  c: 'C', h: 'C', cc: 'C++', cpp: 'C++', hpp: 'C++', rs: 'Rust', go: 'Go', py: 'Python',
  ts: 'TypeScript', js: 'JavaScript', mjs: 'JavaScript', json: 'JSON', toml: 'TOML', yaml: 'YAML', yml: 'YAML',
  md: 'Markdown', txt: 'テキスト', sh: 'shell', html: 'HTML', css: 'CSS',
};

/** What a file is, from its name. */
export function kindOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (/^(GNU)?makefile$/i.test(name)) return 'Makefile';
  const dot = name.lastIndexOf('.');
  return (dot > 0 && KINDS[name.slice(dot + 1).toLowerCase()]) || 'テキスト';
}
