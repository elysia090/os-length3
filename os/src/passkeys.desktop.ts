// passkeys.ts in the desktop app's build (vite.config.ts): the app signs in through the browser, where
// the passkeys are (remote.ts), so it carries no WebAuthn of its own.

import type * as web from './passkeys.ts';
import {t} from './i18n.ts';

export const webauthn: typeof web.webauthn = () => Promise.reject(new Error(t('Passkeys and providers are managed in the browser.')));
