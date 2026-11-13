// The product supplies its words; transfer, resumption and integrity are the distribution's.
import {download as fetchFile, type DownloadMessage} from '../../../module/sods/runtime/web/fetch.ts';
import {t} from '../i18n/i18n.ts';
export * from '../../../module/sods/runtime/web/fetch.ts';

/** Every word a download may say, said here as the app's own: each is in its catalog, and none is missing (the type holds the list whole). */
export const DOWNLOAD_WORDS: Record<DownloadMessage, true> = {
  'Failed to receive remainder': true, 'Size mismatch': true, 'Content mismatch': true,
  'Connection timed out': true, 'Connection lost': true, 'Failed to load': true,
};

export const download: typeof fetchFile = (url, expect, progress, options) =>
  fetchFile(url, expect, progress, {message: t, ...options});
