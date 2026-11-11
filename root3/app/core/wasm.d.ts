// The core built for the browser, as a URL: vite.config.ts builds it with cargo and resolves this name to it.
declare module 'virtual:root3-core.wasm?url' {
  const url: string;
  export default url;
}
