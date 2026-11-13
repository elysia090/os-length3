// The product supplies its words; transfer, resumption and integrity are prompt's.
import {download as fetchFile} from '../../../module/sods/runtime/web/fetch.ts';
import {t} from '../i18n/i18n.ts';
export * from '../../../module/sods/runtime/web/fetch.ts';
export const download: typeof fetchFile = (url, expect, progress, options) =>
  fetchFile(url, expect, progress, {message: t, ...options});
