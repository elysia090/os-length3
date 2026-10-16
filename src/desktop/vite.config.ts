import {defineConfig, type Plugin} from 'vite';

// Tauri serves the built files from ../dist and points its dev webview at this
// fixed port, so the port must not drift to a free one. The Terminal's kernel
// lives in ../../xlat.

/**
 * The web build talks to nothing but its own origin and the Remote: no
 * third-party script, frame, form target or connection. Tauri applies its own policy (with its
 * ipc: channel) to the desktop build, so the meta tag is only for the web.
 * Inline style attributes stay allowed: rows are indented through them, and
 * they cannot run code.
 */
// The Remote (service/) is the one other origin it may reach: where the
// canonical copy lives. VITE_LENGTH3_REMOTE points a build at another one;
// '' is this page's own origin, which in development LENGTH3_DEV_REMOTE
// (a `node service/dev.ts`) answers through the dev server.
const REMOTE_URL = process.env.VITE_LENGTH3_REMOTE ?? 'https://remote.length3.com';
const REMOTE = REMOTE_URL ? new URL(REMOTE_URL).origin : '';
const DEV_REMOTE = process.env.LENGTH3_DEV_REMOTE;
const WEB_POLICY = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", `connect-src 'self'${REMOTE ? ` ${REMOTE}` : ''}`,
  "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');

const webPolicy = (): Plugin => ({
  name: 'length3-web-policy',
  apply: 'build',
  transformIndexHtml(html) {
    if (process.env.TAURI_ENV_PLATFORM) return html;
    return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${WEB_POLICY}">`);
  },
});

export default defineConfig({
  clearScreen: false,
  server: {port: 1420, strictPort: true, fs: {allow: ['../..']},
    proxy: DEV_REMOTE ? {'/api': DEV_REMOTE, '/v1': DEV_REMOTE} : undefined},
  worker: {format: 'es'},
  build: {target: 'es2022', outDir: 'dist', emptyOutDir: true},
  plugins: [webPolicy()],
});
