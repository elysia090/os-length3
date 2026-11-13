// why supplies the distribution, first programs, storage namespace, words and startup assembly.
import {createRoot} from '../../../module/sods/runtime/web/root.ts';
import {FIRST} from './first.ts';
import {errorText} from '../host/errors.ts';
import {isNative} from '../host/host.ts';
import {REMOTE_URL} from '../remote/connection.ts';
import {t} from '../i18n/i18n.ts';
export type {Segment, Blob, About, Index, Webroot, More, Stage} from '../../../module/sods/runtime/web/root.ts';

const root = createRoot({
  base: isNative ? `${REMOTE_URL}/webroot/` : '/webroot/',
  first: FIRST, usedKey: 'why.webroot.used', planKey: 'why.webroot.start',
  oldKeys: ['why.l3.used', 'why.l3.start'], oldCaches: ['l3', 'root3-userland', 'webroot'],
  message: t, missing: () => t('why missing (run: npm run webroot)'), errorText,
});
export const {threadsApart, watchLoad, about, keptWebroot, keepMore, keptNow, originOf, translationKept, keepTranslation, keepReached, usedKept, hearLater, rootIndex: whyIndex, loadWebroot, warmWebroot, filesNow} = root;

// The caller assembles startup. These workers bridge today's Linux-compatibility backend; prompt starts nothing.
export const promptWorker = (): Worker => new Worker(new URL('../host/prompt/kernel.worker.ts', import.meta.url), {type: 'module'});
let spare: {worker: Worker; given: Set<string>} | null = null;
export function readyPrompt(webroot: import('../../../module/sods/runtime/web/root.ts').Webroot, rehearse: {argv: string[]; env: string[]; cwd: string}) {
  if (spare) return;
  const worker = promptWorker(), files = filesNow(webroot);
  worker.postMessage({type: 'warm'});
  worker.postMessage({type: 'ready', translator: webroot.translator, files, root: {index: webroot.index, url: webroot.url}, rehearse});
  spare = {worker, given: new Set(files.map((f) => f.path))};
}
export function takeReady(): {worker: Worker; given: Set<string>} | null {
  const value = spare; spare = null; return value;
}
