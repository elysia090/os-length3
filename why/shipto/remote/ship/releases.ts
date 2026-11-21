// What of a release the Remote serves to anyone, and the digests this tree
// pins for it: the roots why/prompt/roots/pins.rs pins (RELEASES, each why's one pin:
// the root, and the index the browser reads it by; and DISTROS, other
// distributions' roots), served by digest, and the desktop app
// why/shipto/desktop-releases.json pins, served by its file's name. The bucket keeps
// each under a key a person reading R2's list knows at once: release/<version>/<file>
// (why's root and desktop app), distro/<id>-<version>/<file> (another distribution's
// root); a version's files are one folder there, let go of whole.
// The release is made on GitHub, which has no Cloudflare credentials; each
// deploy (deploy.ts, mirror.ts) takes these from the GitHub release (a
// distribution's root from its makers), checks them against these pins, and
// puts what the bucket lacks into it. The service only reads them (app.ts).

import desktopPins from '../../desktop-releases.json' with {type: 'json'};

import type {Pinned} from '../bytes/mirror.ts';
import {named, validName, pinnedRoots as rootPins, type DesktopKind, type DesktopPins, type RootPin} from '../../release-pins.ts';

const DESKTOP_KINDS = {
  deb: 'application/vnd.debian.binary-package',
  // freedesktop.org's shared-mime-info name for it (IANA has none).
  appimage: 'application/vnd.appimage',
} satisfies Record<DesktopKind, string>;
const HEX = /^[0-9a-f]{64}$/;
const tagOf = (version: string) => `os-length3-linux-v${version}`;

const releaseKey = (version: string, file: string) => `release/${named(version, 'version')}/${named(file, 'file')}`;
// A distribution's version as its makers number it (26.04.1 LTS is 26.04.1).
const distroKey = (id: string, version: string, file: string) => `distro/${id}-${named(version.split(' ')[0], 'version')}/${named(file, 'file')}`;

/**
 * Whether a key the deploy recorded is a root, which /v1/os serves by its digest (the desktop app is served by its
 * name alone). os/<sha256> is where a deploy before these names put one; it is served until the deploy puts it anew.
 */
export const isRoot = (key: string) => /^(os|distro)\//.test(key) || /^release\/[^/]+\/[^/]+\.tar\.zst$/.test(key);

/** The pinned roots as served by digest and grouped by version in the bucket. */
export function pinnedRoots(rootRs: string): (Pinned & Pick<RootPin, 'version' | 'web'>)[] {
  return rootPins(rootRs).map(({version, file, tag, sha256, bytes, web}) => ({
    key: releaseKey(version, file), path: `/v1/os/${sha256}`, tag, file, sha256, bytes,
    type: 'application/octet-stream', version, web,
  }));
}

/** The other distributions' roots why/prompt/roots/pins.rs pins (DISTROS), by digest as roots are, from their makers. */
export function pinnedDistros(rootRs: string): Pinned[] {
  const at = rootRs.indexOf('pub const DISTROS: &[Distro] = &[');
  const end = rootRs.indexOf('];', at);
  if (at < 0 || end < 0) throw new Error('why/prompt/roots/pins.rs has no DISTROS');
  const list = rootRs.slice(at, end);
  const distros = [...list.matchAll(
    /Distro \{\s*id: "([a-z]+)",\s*name: "[^"]*",\s*version: "([^"]+)",\s*url: "(https:\/\/[^"]+)",\s*sha256: "([0-9a-f]{64})",\s*bytes: ([\d_]+),\s*\}/g)]
    .map(([, id, version, url, sha256, bytes]) => ({key: distroKey(id, version, url.slice(url.lastIndexOf('/') + 1)), path: `/v1/os/${sha256}`, tag: `${id} ${version}`,
      file: url.slice(url.lastIndexOf('/') + 1), sha256, bytes: Number(bytes.replace(/_/g, '')), type: 'application/octet-stream', url}));
  if (distros.length !== (list.match(/Distro \{/g) ?? []).length) throw new Error('why/prompt/roots/pins.rs: a DISTROS entry is not as written there');
  return distros;
}

/** The desktop app's files this tree pins for `version` (none when it pins none). */
export function pinnedDesktop(version: string, pins: DesktopPins = desktopPins as DesktopPins): Pinned[] {
  return Object.entries(pins[version] ?? {}).map(([kind, p]) => {
    const type = DESKTOP_KINDS[kind as DesktopKind];
    if (!type || !p || !HEX.test(p.sha256) || !Number.isSafeInteger(p.bytes) || p.bytes <= 0 || !p.file.includes(`-${version}-`) || !validName(p.file) || !validName(version))
      throw new Error(`why/shipto/desktop-releases.json: ${version} ${kind} is not a pin (file, bytes, sha256)`);
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
