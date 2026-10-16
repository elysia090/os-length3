import {defineConfig} from 'vite';

// Tauri serves the built files from ../dist and points its dev webview at this
// fixed port, so the port must not drift to a free one. The Terminal's kernel
// lives in ../../xlat.

export default defineConfig({
  clearScreen: false,
  server: {port: 1420, strictPort: true, fs: {allow: ['../..']}},
  worker: {format: 'es'},
  build: {target: 'es2022', outDir: 'dist', emptyOutDir: true},
});
