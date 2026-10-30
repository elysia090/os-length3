import {devices} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

/** os/, where the app, the Remote and their package are. */
export const OS = fileURLToPath(new URL('..', import.meta.url));
/** The selftest's own build of the app (for a Remote on its own origin). */
export const OUT = join(OS, 'selftest', '.dist');
/** What the Remote and the preview printed, for a failure to be read by. */
export const LOGS = join(OS, 'selftest', '.logs');

/**
 * How every person's browser is: a desktop Chrome window, in English, on UTC, asking for less motion, as some people's
 * do: each thing is where it ends at once, so a step waits on what the OS does, not on a move settling (a third of a
 * run went to that). The moves themselves are motion.spec.ts's, which asks for them.
 */
export const BROWSER = {...devices['Desktop Chrome'], viewport: {width: 1400, height: 900}, locale: 'en-US', timezoneId: 'UTC',
  reducedMotion: 'reduce' as const};
