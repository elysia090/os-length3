import {devices} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';

/** os/, where the app, the Remote and their package are. */
export const OS = fileURLToPath(new URL('..', import.meta.url));
/** The selftest's own build of the app (for a Remote on its own origin). */
export const OUT = join(OS, 'tests', '.dist');
/** What the Remote and the preview printed, for a failure to be read by. */
export const LOGS = join(OS, 'tests', '.logs');

/**
 * The root's own command in the web root this build carries: root3, or l3 in a root released before it was named so
 * (0.6.4, which main pins until the next release).
 */
export function rootCommand(): string {
  try {
    const dir = join(OS, 'public', 'webroot');
    const about = JSON.parse(readFileSync(join(dir, 'webroot.json'), 'utf8')) as {index: {path: string}};
    const index = JSON.parse(readFileSync(join(dir, about.index.path), 'utf8')) as {files: {path: string}[]};
    return index.files.some((f) => f.path === '/usr/bin/root3') ? 'root3' : 'l3';
  } catch { return 'root3'; }
}

/**
 * How every person's browser is: a desktop Chrome window, in English, on UTC, asking for less motion, as some people's
 * do: each thing is where it ends at once, so a step waits on what the OS does, not on a move settling (a third of a
 * run went to that). The moves themselves are motion.spec.ts's, which asks for them.
 */
export const BROWSER = {...devices['Desktop Chrome'], viewport: {width: 1400, height: 900}, locale: 'en-US', timezoneId: 'UTC',
  reducedMotion: 'reduce' as const};
