// core-worker.ts in the desktop app's build (vite.config.ts): the app's core is its own (host.ts), never
// the browser's, so there is no worker to start.

import type * as web from './core-worker.ts';

export const coreWorker: typeof web.coreWorker = () => { throw new Error('The desktop app runs its own core, not the browser\'s'); };
