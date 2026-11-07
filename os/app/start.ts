// The page's first script (index.html, async): small, so it runs as soon as it arrives, before the page's stylesheet
// and the app's own code (main.ts, fetched beside it: the build names it in the page to be fetched at once,
// vite.config.ts) have. In a browser it starts the core first (core/client.ts start: its worker fetches and compiles
// the core's module and opens what this browser keeps), which is the longest wait before Home can be drawn, so it
// runs while the rest arrives rather than after it has. The app itself runs once the page is read and styled, as a
// module script of the page's own would.

import {start} from './core/client.ts';

/** Which host this build is for (vite.config.ts); run from source, the page says (as app/host.ts reads it). */
declare const __LENGTH3_HOST__: 'native' | 'web' | undefined;
const web = typeof __LENGTH3_HOST__ === 'string' ? __LENGTH3_HOST__ === 'web' : !('__TAURI_INTERNALS__' in globalThis);
if (web) start();

/** Once the page is read and each of its stylesheets is in (or has failed): where a deferred script runs. */
async function ready(): Promise<void> {
  if (document.readyState === 'loading') await new Promise((done) => document.addEventListener('DOMContentLoaded', done, {once: true}));
  await Promise.all([...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((link) => link.sheet ?? new Promise((done) => {
    link.addEventListener('load', done, {once: true});
    link.addEventListener('error', done, {once: true});
  })));
}

// boot.js says the app could not start once the page has loaded with no rail drawn; while the app's code is still
// on its way (a slow line), the page is marked so, and boot.js waits for it. Should it fail, boot.js hears why.
const root = document.documentElement;
root.classList.add('loading');
void ready().then(() => import('./main.ts')).finally(() => root.classList.remove('loading'));
