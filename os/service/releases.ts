// What of a release the Remote serves to anyone, and the digests this tree
// pins for it: the roots core/src/root.rs pins (RELEASES), by digest under
// os/<sha256>, and the desktop app shared/desktop-releases.json pins, by its
// file's name under desktop/<file>. The release is made on GitHub, which has
// no Cloudflare credentials; each deploy (deploy.ts, mirror.ts) takes these
// from the GitHub release, checks them against these pins, and puts what the
// bucket lacks into it. The service only reads them (app.ts).

import desktopPins from '../shared/desktop-releases.json' with {type: 'json'};

/** One file of a release as this tree pins it: where the bucket keeps it, where the Remote serves it, where GitHub has it. */
export interface Pinned {
  key: string;
  path: string;
  tag: string;
  file: string;
  sha256: string;
  bytes: number;
  type: string;
}

export const DESKTOP_KINDS = {
  deb: 'application/vnd.debian.binary-package',
  // freedesktop.org's shared-mime-info name for it (IANA has none).
  appimage: 'application/vnd.appimage',
} as const;
export type DesktopKind = keyof typeof DESKTOP_KINDS;
export type DesktopPins = Record<string, Partial<Record<DesktopKind, {file: string; bytes: number; sha256: string}>>>;

const HEX = /^[0-9a-f]{64}$/;
const tagOf = (version: string) => `os-length3-linux-v${version}`;

export const rootKey = (sha256: string) => `os/${sha256}`;
export const desktopKey = (file: string) => `desktop/${file}`;

/** The roots core/src/root.rs pins, newest first, as RELEASES lists them. */
export function pinnedRoots(rootRs: string): Pinned[] {
  const at = rootRs.indexOf('pub const RELEASES: &[Release] = &[');
  const end = rootRs.indexOf('];', at);
  if (at < 0 || end < 0) throw new Error('core/src/root.rs has no RELEASES');
  const roots = [...rootRs.slice(at, end).matchAll(
    /Release \{\s*name: "[^"]*",\s*version: "([^"]+)",\s*sha256: "([0-9a-f]{64})",\s*bytes: ([\d_]+),\s*file: "([^"]+)",\s*tag: "([^"]+)",\s*\}/g)]
    .map(([, , sha256, bytes, file, tag]) => ({key: rootKey(sha256), path: `/v1/os/${sha256}`, tag, file, sha256, bytes: Number(bytes.replace(/_/g, '')), type: 'application/octet-stream'}));
  // Every entry is read, or none is: an entry the pattern missed would be a root left out unsaid.
  if (roots.length !== (rootRs.slice(at, end).match(/Release \{/g) ?? []).length) throw new Error('core/src/root.rs: a RELEASES entry is not as pin-root.mjs writes one');
  return roots;
}

/** The desktop app's files this tree pins for `version` (none when it pins none). */
export function pinnedDesktop(version: string, pins: DesktopPins = desktopPins as DesktopPins): Pinned[] {
  return Object.entries(pins[version] ?? {}).map(([kind, p]) => {
    const type = DESKTOP_KINDS[kind as DesktopKind];
    if (!type || !p || !HEX.test(p.sha256) || !Number.isSafeInteger(p.bytes) || p.bytes <= 0 || !p.file.includes(`-${version}-`) || !/^[A-Za-z0-9._+-]+$/.test(p.file))
      throw new Error(`shared/desktop-releases.json: ${version} ${kind} is not a pin (file, bytes, sha256)`);
    return {key: desktopKey(p.file), path: `/v1/desktop/${p.file}`, tag: tagOf(version), file: p.file, sha256: p.sha256, bytes: p.bytes, type};
  });
}

/** A desktop file the Remote serves, by its name: one this tree pins, for any version. */
export function desktopFile(file: string, pins: DesktopPins = desktopPins as DesktopPins): Pinned | null {
  for (const version of Object.keys(pins)) {
    const found = pinnedDesktop(version, pins).find((p) => p.file === file);
    if (found) return found;
  }
  return null;
}
