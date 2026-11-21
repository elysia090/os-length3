// The root as a page runs it is ricebox's, all of it (ricebox/distribution/runtime: its layers fetched, kept and mounted, the
// Worker that runs it in a box muk makes, what is translated ahead). What is said here is the product's: where its
// root is served from, the names its page keeps things by, and its words.
import {createRoot} from '../../ricebox/distribution/runtime/root.ts';
import {errorText} from '../api/errors.ts';
import {isNative} from '../api/host.ts';
import {REMOTE_URL} from '../shipto/connection.ts';
import {t} from '../text/i18n.ts';
export {retireRootWorker, BOX, type Segment, type Blob, type About, type Box, type Index, type Webroot, type PreparedRoot, type More, type Stage} from '../../ricebox/distribution/runtime/root.ts';
export {aheadFor} from '../../ricebox/distribution/runtime/pretranslate.ts';

const root = createRoot({
  base: isNative ? `${REMOTE_URL}/webroot/` : '/webroot/',
  usedKey: 'why.webroot.used', planKey: 'why.webroot.start',
  oldKeys: ['why.l3.used', 'why.l3.start'], oldCaches: ['l3', 'root3-userland', 'webroot'],
  message: t, missing: () => t('Ricebox root missing (run: npm run webroot)'), errorText,
});
export const {threadsApart, watchLoad, about, keptWebroot, keepMore, keptNow, originOf, translationKept, keepTranslation, keepReached, usedKept, hearLater, rootIndex: whyIndex, loadWebroot, warmWebroot, filesNow,
  rootWorker: promptWorker, readyWorker: readyPrompt, takeReady, hearAhead, holdAhead, translateAhead} = root;

/** Explicit lazy canonical-source execution; the byte-bearing legacy exports above stay unchanged. */
export const executionRoot = root.execution;
