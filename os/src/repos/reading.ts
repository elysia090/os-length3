/** Reading order inside a directory: README first, the other files, then the directories. */
export function readingOrder<T extends {name: string; kind: string}>(entries: readonly T[]): T[] {
  const rank = (e: T) => (e.kind === 'dir' ? 2 : /^readme(\.|$)/i.test(e.name) ? 0 : 1);
  return [...entries].sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Lines as an editor counts them: a final newline does not start another. */
export function lineCount(text: string): number {
  if (!text) return 0;
  // Counted where they are, not split apart: the editor asks at every keystroke.
  let n = 0;
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) n++;
  return n + (text.endsWith('\n') ? 0 : 1);
}
