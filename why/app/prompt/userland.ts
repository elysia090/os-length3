// The root as a page runs it is ricebox's, all of it (module/ricebox/layers: its layers fetched, kept and mounted, the
// Worker that runs it in a box muk makes, what is translated ahead). What is said here is the product's: where its
// root is served from, the names its page keeps things by, and its words.
import {createRoot} from '../../../module/ricebox/layers/root.ts';
import {errorText} from '../host/errors.ts';
import {isNative} from '../host/host.ts';
import {REMOTE_URL} from '../remote/connection.ts';
import {t} from '../i18n/i18n.ts';
export {BOX, type Segment, type Blob, type About, type Box, type Index, type Webroot, type More, type Stage} from '../../../module/ricebox/layers/root.ts';
export {aheadFor} from '../../../module/ricebox/layers/ahead.ts';

const root = createRoot({
  base: isNative ? `${REMOTE_URL}/webroot/` : '/webroot/',
  usedKey: 'why.webroot.used', planKey: 'why.webroot.start',
  oldKeys: ['why.l3.used', 'why.l3.start'], oldCaches: ['l3', 'root3-userland', 'webroot'],
  message: t, missing: () => t('why missing (run: npm run webroot)'), errorText,
});
export const {threadsApart, watchLoad, about, keptWebroot, keepMore, keptNow, originOf, translationKept, keepTranslation, keepReached, usedKept, hearLater, rootIndex: whyIndex, loadWebroot, warmWebroot, filesNow,
  rootWorker: promptWorker, readyWorker: readyPrompt, takeReady, hearAhead, holdAhead, translateAhead} = root;
