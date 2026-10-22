// The web app's Content Security Policy, and the headers its own files are
// served with (public/_headers): one source for the build's <meta> tag
// (vite.config.ts), the preview the selftest runs against, and the test that
// _headers says the same (headers.test.ts).

/**
 * The web build talks to nothing but its own origin and the Remote (`remote`, an origin, or '' when
 * the Remote is this page's own origin): no third-party script, frame, form target or connection.
 * WebAssembly is compiled ('wasm-unsafe-eval': the Prompt's translator), never JavaScript from text.
 * Inline style attributes stay allowed: rows are indented through them, and they cannot run code.
 */
export const webPolicy = (remote: string) => [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", `connect-src 'self'${remote ? ` ${remote}` : ''}`,
  "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');

/** The headers `_headers` gives every path (its `/*` block), by name. */
export function headersOf(text: string, block = '/*'): Record<string, string> {
  const lines = text.split('\n');
  const out: Record<string, string> = {};
  let i = lines.findIndex((l) => l.trim() === block);
  if (i < 0) return out;
  for (i++; i < lines.length && /^\s+\S/.test(lines[i]); i++) {
    const m = /^\s+([A-Za-z-]+):\s*(.*)$/.exec(lines[i]);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
