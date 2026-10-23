// userland.ts in the desktop app's build (vite.config.ts). The app's Prompt is the root installed on this
// machine (host.ts, l3 prompt); l3 as a browser reads it (public/l3, xlat) is the web's, and the app's build
// carries none of it: each of these says so, or that there is nothing of it here.

import type * as web from './userland.ts';
import {t} from './i18n.ts';

const webOnly = () => new Error(t('The app\'s Prompt runs on the root this device installs (Runtime), not through xlat'));

export const threadsApart: typeof web.threadsApart = () => false;
export const FIRST: typeof web.FIRST = [];
export const watchLoad: typeof web.watchLoad = () => () => {};
export const about: typeof web.about = async () => null;
export const keptL3: typeof web.keptL3 = async () => ({bytes: 0, files: 0});
export const forgetL3: typeof web.forgetL3 = async () => 0;
export const l3Index: typeof web.l3Index = async () => null;
export const loadL3: typeof web.loadL3 = () => Promise.reject(webOnly());
export const warmL3: typeof web.warmL3 = () => {};
export const filesNow: typeof web.filesNow = () => [];
export const promptWorker: typeof web.promptWorker = () => { throw webOnly(); };
