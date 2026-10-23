// What of a release the Remote serves to anyone, and the digests this tree
// pins for it: the roots core/src/root.rs pins (RELEASES, each l3's one pin:
// the root, and the index the browser reads it by), by digest under
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

/** Versions compared part by part as numbers (0.10.0 after 0.9.0); a pre-release (0.5.1-rc.1) before its release. */
export function byVersion(a: string, b: string): number {
  const [x, xp = ''] = a.split('-', 2), [y, yp = ''] = b.split('-', 2);
  const xs = x.split('.').map(Number), ys = y.split('.').map(Number);
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) if ((xs[i] ?? 0) !== (ys[i] ?? 0)) return (xs[i] ?? 0) - (ys[i] ?? 0);
  return xp === yp ? 0 : !xp ? 1 : !yp ? -1 : xp < yp ? -1 : 1;
}

/**
 * The version whose pins a build ships: RELEASE, once this tree pins it. While a release of it is made (RELEASE
 * changed on main, its files not published and pinned yet), the newest pinned before it: main's build and deploy
 * go on with what they had, rather than failing (no l3 for the web) or offering no desktop app. Null when none is.
 */
export function shipping(release: string, pinned: readonly string[]): string | null {
  if (pinned.includes(release)) return release;
  return [...pinned].filter((v) => byVersion(v, release) < 0).sort(byVersion).at(-1) ?? null;
}

/** The versions shared/desktop-releases.json pins a desktop app for. */
export const desktopVersions = (pins: DesktopPins = desktopPins as DesktopPins): string[] => Object.keys(pins);

/** A root as core/src/root.rs pins it: its version, and l3's index for the browser made from it (`web`, its sha256; '' before l3 had one). */
export interface PinnedRoot extends Pinned { version: string; web: string }

/** The roots core/src/root.rs pins, newest first, as RELEASES lists them. */
export function pinnedRoots(rootRs: string): PinnedRoot[] {
  const at = rootRs.indexOf('pub const RELEASES: &[Release] = &[');
  const end = rootRs.indexOf('];', at);
  if (at < 0 || end < 0) throw new Error('core/src/root.rs has no RELEASES');
  const roots = [...rootRs.slice(at, end).matchAll(
    /Release \{\s*name: "[^"]*",\s*version: "([^"]+)",\s*sha256: "([0-9a-f]{64})",\s*bytes: ([\d_]+),\s*file: "([^"]+)",\s*tag: "([^"]+)",\s*web: "((?:[0-9a-f]{64})?)",\s*\}/g)]
    .map(([, version, sha256, bytes, file, tag, web]) => ({key: rootKey(sha256), path: `/v1/os/${sha256}`, tag, file, sha256, bytes: Number(bytes.replace(/_/g, '')), type: 'application/octet-stream', version, web}));
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
