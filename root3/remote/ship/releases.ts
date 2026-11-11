// What of a release the Remote serves to anyone, and the digests this tree
// pins for it: the roots root3/core/src/root/pins.rs pins (RELEASES, each root3's one pin:
// the root, and the index the browser reads it by; and DISTROS, other
// distributions' roots), served by digest, and the desktop app
// root3/shared/desktop-releases.json pins, served by its file's name. The bucket keeps
// each under a key a person reading R2's list knows at once: release/<version>/<file>
// (root3's root and desktop app), distro/<id>-<version>/<file> (another distribution's
// root); a version's files are one folder there, let go of whole.
// The release is made on GitHub, which has no Cloudflare credentials; each
// deploy (deploy.ts, mirror.ts) takes these from the GitHub release (a
// distribution's root from its makers), checks them against these pins, and
// puts what the bucket lacks into it. The service only reads them (app.ts).

import desktopPins from '../../shared/desktop-releases.json' with {type: 'json'};

import type {Pinned} from '../bytes/mirror.ts';

const DESKTOP_KINDS = {
  deb: 'application/vnd.debian.binary-package',
  // freedesktop.org's shared-mime-info name for it (IANA has none).
  appimage: 'application/vnd.appimage',
} as const;
type DesktopKind = keyof typeof DESKTOP_KINDS;
type DesktopPins = Record<string, Partial<Record<DesktopKind, {file: string; bytes: number; sha256: string}>>>;

const HEX = /^[0-9a-f]{64}$/;
const tagOf = (version: string) => `os-length3-linux-v${version}`;

const NAME = /^[A-Za-z0-9._+-]+$/;
/** A plain name, one folder's or one file's: never a path, nor one a key could climb out of. */
const named = (name: string, what: string) => {
  if (!NAME.test(name) || /^\.+$/.test(name)) throw new Error(`a release's ${what} ${JSON.stringify(name)} is not a plain name`);
  return name;
};
const releaseKey = (version: string, file: string) => `release/${named(version, 'version')}/${named(file, 'file')}`;
// A distribution's version as its makers number it (26.04.1 LTS is 26.04.1).
const distroKey = (id: string, version: string, file: string) => `distro/${id}-${named(version.split(' ')[0], 'version')}/${named(file, 'file')}`;

/**
 * Whether a key the deploy recorded is a root, which /v1/os serves by its digest (the desktop app is served by its
 * name alone). os/<sha256> is where a deploy before these names put one; it is served until the deploy puts it anew.
 */
export const isRoot = (key: string) => /^(os|distro)\//.test(key) || /^release\/[^/]+\/[^/]+\.tar\.zst$/.test(key);

/** A root as root3/core/src/root/pins.rs pins it: its version, and root3's index for the browser made from it (`web`, its sha256; '' before root3 had one). */
interface PinnedRoot extends Pinned { version: string; web: string }

/** The roots root3/core/src/root/pins.rs pins, newest first, as RELEASES lists them. */
export function pinnedRoots(rootRs: string): PinnedRoot[] {
  const at = rootRs.indexOf('pub const RELEASES: &[Release] = &[');
  const end = rootRs.indexOf('];', at);
  if (at < 0 || end < 0) throw new Error('root3/core/src/root/pins.rs has no RELEASES');
  const roots = [...rootRs.slice(at, end).matchAll(
    /Release \{\s*name: "[^"]*",\s*version: "([^"]+)",\s*sha256: "([0-9a-f]{64})",\s*bytes: ([\d_]+),\s*file: "([^"]+)",\s*tag: "([^"]+)",\s*web: "((?:[0-9a-f]{64})?)",\s*\}/g)]
    .map(([, version, sha256, bytes, file, tag, web]) => ({key: releaseKey(version, file), path: `/v1/os/${sha256}`, tag, file, sha256, bytes: Number(bytes.replace(/_/g, '')), type: 'application/octet-stream', version, web}));
  // Every entry is read, or none is: an entry the pattern missed would be a root left out unsaid.
  if (roots.length !== (rootRs.slice(at, end).match(/Release \{/g) ?? []).length) throw new Error('root3/core/src/root/pins.rs: a RELEASES entry is not as pin-root.ts writes one');
  return roots;
}

/** The other distributions' roots root3/core/src/root/pins.rs pins (DISTROS), by digest as roots are, from their makers. */
export function pinnedDistros(rootRs: string): Pinned[] {
  const at = rootRs.indexOf('pub const DISTROS: &[Distro] = &[');
  const end = rootRs.indexOf('];', at);
  if (at < 0 || end < 0) throw new Error('root3/core/src/root/pins.rs has no DISTROS');
  const list = rootRs.slice(at, end);
  const distros = [...list.matchAll(
    /Distro \{\s*id: "([a-z]+)",\s*name: "[^"]*",\s*version: "([^"]+)",\s*url: "(https:\/\/[^"]+)",\s*sha256: "([0-9a-f]{64})",\s*bytes: ([\d_]+),\s*\}/g)]
    .map(([, id, version, url, sha256, bytes]) => ({key: distroKey(id, version, url.slice(url.lastIndexOf('/') + 1)), path: `/v1/os/${sha256}`, tag: `${id} ${version}`,
      file: url.slice(url.lastIndexOf('/') + 1), sha256, bytes: Number(bytes.replace(/_/g, '')), type: 'application/octet-stream', url}));
  if (distros.length !== (list.match(/Distro \{/g) ?? []).length) throw new Error('root3/core/src/root/pins.rs: a DISTROS entry is not as written there');
  return distros;
}

/**
 * The version this tree ships: the newest whose desktop app it pins (its root is pinned in the same change,
 * scripts/pin-root.ts and pin-desktop.ts). module/ricebox/RELEASE names the version being made, which is shipped once the
 * release has pinned it: the web, its build and the deploy take this one, never module/ricebox/RELEASE.
 */
export function shipped(pins: DesktopPins = desktopPins as DesktopPins): string {
  return Object.keys(pins).sort((a, b) => a.localeCompare(b, 'en', {numeric: true})).at(-1) ?? '';
}

/** The desktop app's files this tree pins for `version` (none when it pins none). */
export function pinnedDesktop(version: string, pins: DesktopPins = desktopPins as DesktopPins): Pinned[] {
  return Object.entries(pins[version] ?? {}).map(([kind, p]) => {
    const type = DESKTOP_KINDS[kind as DesktopKind];
    if (!type || !p || !HEX.test(p.sha256) || !Number.isSafeInteger(p.bytes) || p.bytes <= 0 || !p.file.includes(`-${version}-`) || !NAME.test(p.file) || !NAME.test(version))
      throw new Error(`root3/shared/desktop-releases.json: ${version} ${kind} is not a pin (file, bytes, sha256)`);
    return {key: releaseKey(version, p.file), path: `/v1/desktop/${p.file}`, tag: tagOf(version), file: p.file, sha256: p.sha256, bytes: p.bytes, type};
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
