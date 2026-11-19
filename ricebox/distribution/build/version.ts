import {readFileSync} from 'node:fs';

/** This producer's version, including when it is consumed from a local npm package. */
export function releaseVersion(): string {
  const version = readFileSync(new URL('../RELEASE', import.meta.url), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(version)) throw new Error('ricebox: invalid RELEASE version');
  return version;
}
