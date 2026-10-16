import {defineConfig} from 'vite';

// Tauri serves the built files from ../dist and points its dev webview at this
// fixed port, so the port must not drift to a free one.
export default defineConfig({
  clearScreen: false,
  server: {port: 1420, strictPort: true},
  build: {target: 'es2022', outDir: 'dist', emptyOutDir: true},
});
