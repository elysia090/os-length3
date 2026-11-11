// What a word of a terminal's output names in the repo (term-links.ts): its path, and the line said after it.

/**
 * `text` (a word of a terminal's output) as a path in `repo` and a line: quotes and a trailing colon or comma off, a
 * `:line` or `:line:column` after it kept apart, `./` and the repo's own `/root/<repo>/` off its head. Null when it
 * cannot be a path.
 */
export function asPath(text: string, repo: string): {path: string; line: number} | null {
  const t = text.replace(/^['"(<]+|['"),;>.]+$/g, '').replace(/:$/, '');
  const m = /^(.+?)(?::(\d+))?(?::\d+)?$/.exec(t);
  if (!m) return null;
  let path = m[1];
  const own = `/root/${repo}/`;
  if (path.startsWith(own)) path = path.slice(own.length);
  else if (path.startsWith('/')) return null;
  while (path.startsWith('./')) path = path.slice(2);
  if (!path || path.split('/').some((p) => p === '..' || p === '')) return null;
  return {path, line: m[2] ? Number(m[2]) : 0};
}
