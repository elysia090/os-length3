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
// The Remote (remote/) is the one other origin it may reach: where the
// canonical copy lives. VITE_LENGTH3_REMOTE points a build at another one
// (a local remote/serve.ts while developing).
const REMOTE = new URL(process.env.VITE_LENGTH3_REMOTE ?? 'https://remote.length3.com').origin;
const WEB_POLICY = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'",
  "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", `connect-src 'self' ${REMOTE}`,
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
  server: {port: 1420, strictPort: true, fs: {allow: ['../..']}},
  worker: {format: 'es'},
  build: {target: 'es2022', outDir: 'dist', emptyOutDir: true},
  plugins: [webPolicy()],
});
