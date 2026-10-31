// The web app's Content Security Policy, and the headers its own files are
// served with (public/_headers): one source for the build's <meta> tag
// (vite.config.ts), the preview the selftest runs against, and the test that
// _headers says the same (headers.test.ts).

import {MAKER_ORIGINS} from '../agent/makers.ts';

/** The Remote this OS ships with: one name for the app, the Remote, the DNS records people publish and passkeys. */
export const DEFAULT_REMOTE = 'https://os.length3.com';

/** Where the page may connect besides itself: the Remote (`remote`, an origin, or '' when it is the page's own), and
 * the APIs of the models' makers the box's Agent asks with the key kept on the device (agent/makers.ts), nothing else. */
const reaches = (remote: string) => [...(remote ? [remote] : []), ...MAKER_ORIGINS].join(' ');

/**
 * The web build talks to nothing but its own origin, the Remote and, for the Agent, the models' makers (reaches): no
 * third-party script, frame or form target, and no connection elsewhere.
 * WebAssembly is compiled ('wasm-unsafe-eval': the Prompt's translator), never JavaScript from text.
 * Inline style attributes stay allowed: rows are indented through them, and they cannot run code.
 */
export const webPolicy = (remote: string) => [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", `connect-src 'self' ${reaches(remote)}`,
  "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');

/**
 * The desktop app's webview policy (src-tauri/tauri.conf.json, which says it for DEFAULT_REMOTE; scripts/desktop.sh
 * gives Tauri this for the Remote a build is for): the web's, with the app's ipc: channel, but no WebAssembly and
 * no worker, since the app's core and its Prompt are its own (vite.config.ts leaves the browser's out of its build),
 * and no inline style.
 */
export const desktopPolicy = (remote: string) => [
  "default-src 'self'", "script-src 'self'", "worker-src 'none'", "style-src 'self'", "img-src 'self' data:",
  `connect-src 'self' ipc: http://ipc.localhost ${reaches(remote)}`,
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'",
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
