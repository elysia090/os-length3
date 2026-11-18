// Why release pins are product metadata. Downloaders need the same pin
// values as the hosted Remote but do not need its delivery paths or bucket.
import desktopPins from './desktop-releases.json' with {type: 'json'};

export type DesktopKind = 'deb' | 'appimage';
export type DesktopPins = Record<string, Partial<Record<DesktopKind, {file: string; bytes: number; sha256: string}>>>;
export interface RootPin {
  version: string;
  file: string;
  tag: string;
  sha256: string;
  bytes: number;
  /** Web index digest; historical native-only releases leave this empty. */
  web: string;
}

const NAME = /^[A-Za-z0-9._+-]+$/;
/** One file or directory name, not a path. */
export const validName = (name: string): boolean => NAME.test(name) && !/^\.+$/.test(name);
export const named = (name: string, what: string) => {
  if (!validName(name)) throw new Error(`a release's ${what} ${JSON.stringify(name)} is not a plain name`);
  return name;
};

/** The roots why/prompt/roots/pins.rs pins, newest first, as RELEASES lists them. */
export function pinnedRoots(rootRs: string): RootPin[] {
  const at = rootRs.indexOf('pub const RELEASES: &[Release] = &[');
  const end = rootRs.indexOf('];', at);
  if (at < 0 || end < 0) throw new Error('why/prompt/roots/pins.rs has no RELEASES');
  const roots = [...rootRs.slice(at, end).matchAll(
    /Release \{\s*name: "[^"]*",\s*version: "([^"]+)",\s*sha256: "([0-9a-f]{64})",\s*bytes: ([\d_]+),\s*file: "([^"]+)",\s*tag: "([^"]+)",\s*web: "((?:[0-9a-f]{64})?)",\s*\}/g)]
    .map(([, version, sha256, bytes, file, tag, web]) => ({
      version: named(version, 'version'), file: named(file, 'file'), tag, sha256,
      bytes: Number(bytes.replace(/_/g, '')), web,
    }));
  // Every entry is read, or none is: an entry the pattern missed would be a root left out unsaid.
  if (roots.length !== (rootRs.slice(at, end).match(/Release \{/g) ?? []).length) throw new Error('why/prompt/roots/pins.rs: a RELEASES entry is not as pin-root.ts writes one');
  return roots;
}

/** The newest desktop version pinned for shipping, not the version being built. */
export function shipped(pins: DesktopPins = desktopPins as DesktopPins): string {
  return Object.keys(pins).sort((a, b) => a.localeCompare(b, 'en', {numeric: true})).at(-1) ?? '';
}
