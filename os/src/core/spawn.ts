// The browser's core, started: its worker (core/worker.ts) and the module it runs. A file of its own so
// the desktop app's build, whose core is the app's own (host.ts), carries none of it: there this file is
// core/spawn.desktop.ts (vite.config.ts).

export const coreWorker = (): Worker => new Worker(new URL('./worker.ts', import.meta.url), {type: 'module'});
