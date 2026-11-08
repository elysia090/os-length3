// What `node:worker_threads` is in a browser: nothing. xlat's runtime (cpu.ts, remote.ts) imports it only when it
// runs under Node, and the app's build bundles the same files for the browser, where that import is never made;
// the bundle takes this in its place rather than a Node module it cannot use.
export const parentPort = undefined;
export const Worker = undefined;
