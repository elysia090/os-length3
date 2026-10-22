import {defineConfig} from '@playwright/test';
import {BROWSER} from './paths.ts';

// `npm run selftest`: global-setup.ts builds the app and starts a fresh
// Remote and the preview on free ports, then every *.spec.ts here runs
// against them in Chromium (README.md, Develop). Tests tagged @slow (the
// browser's Prompt) skip themselves unless SELFTEST_SLOW=1, as CI sets.
const CI = !!process.env.CI;

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: '.results',
  globalSetup: './global-setup.ts',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  // A journey is a few dozen steps against a real Remote; on a busy machine the steps are slow, never the waits.
  timeout: 60_000,
  expect: {timeout: 15_000},
  // On CI, each failure is also an annotation on the run (and a flaky one is named as such).
  reporter: [['list'], ...(CI ? [['github'] as const] : []), ['html', {open: 'never', outputFolder: '.report'}]],
  use: {
    ...BROWSER,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
