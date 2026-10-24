// tauri.ts in the web's build (vite.config.ts): a browser has no app around it, so nothing here is reached
// (host.ts asks only where isNative); if it were, it says so rather than loading Tauri's API. The window's name
// is the one thing both have: a browser names its tab from document.title, so there it is already done.

import type * as app from './tauri.ts';

const appOnly = () => new Error('Only the desktop app has this');

export const invoke: typeof app.invoke = () => Promise.reject(appOnly());
export const listen: typeof app.listen = () => Promise.reject(appOnly());
export const setWindowTitle: typeof app.setWindowTitle = () => Promise.resolve();
