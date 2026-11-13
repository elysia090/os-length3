// The product supplies its words; transfer, resumption and integrity are the distribution's (ricebox's layers).
import {download as fetchFile, type DownloadMessage} from '../../../module/ricebox/layers/fetch.ts';
import {t} from '../i18n/i18n.ts';
export * from '../../../module/ricebox/layers/fetch.ts';

/** Every word a download may say, said here as the app's own: each is in its catalog, and none is missing (the type holds the list whole). */
export const DOWNLOAD_WORDS: Record<DownloadMessage, true> = {
  'Failed to receive remainder': true, 'Size mismatch': true, 'Content mismatch': true,
  'Connection timed out': true, 'Connection lost': true, 'Failed to load': true,
};

export const download: typeof fetchFile = (url, expect, progress, options) =>
  fetchFile(url, expect, progress, {message: t, ...options});

/** Where an earlier build kept copies of why; nothing is kept there now. */
const STORE = 'why-userland';

/** Give back every copy an earlier build kept in Cache Storage except those named in `live`. */
export async function forgetExcept(live: Set<string>) {
  try {
    if (!('caches' in globalThis)) return;
    const c = await caches.open(STORE);
    for (const req of await c.keys()) {
      const sha = new URL(req.url).pathname.split('/').at(-1)!;
      if (!live.has(sha)) await c.delete(req);
    }
    if (!live.size) await caches.delete(STORE);
  } catch { /* nothing to give back */ }
}
