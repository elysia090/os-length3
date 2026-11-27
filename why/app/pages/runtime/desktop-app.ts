import {h} from '../../ui/dom.ts';
import {bytes} from '../../../text/format.ts';
import {t} from '../../../text/i18n.ts';
import {REMOTE_URL} from '../../../shipto/connection.ts';
import {mark} from '../../ui/icons.ts';
import desktopPins from '../../../shipto/desktop-releases.json' with {type: 'json'};

// The desktop app is offered below the web environments.

const env = (import.meta as {env?: Record<string, string>}).env;
const WHY_VERSION = env?.VITE_LENGTH3_WHY_VERSION ?? '';
/** The published distribution release that supplies the installer. */
const INSTALLER_RELEASE = env?.VITE_LENGTH3_RELEASE ?? '';

/**
 * The desktop app, on the web only: one row saying what it is (why*,
 * its version apart in the mono face) and which file with its size, and
 * Download (its icon and the word, a size smaller than a small button) at its
 * edge, as a deed that leaves the page for this computer. Download
 * gives the .deb (Debian, Ubuntu: most of x86-64 Linux), or the AppImage when
 * the Remote has no .deb; one download only. Both come from the Remote (the
 * deploy puts the pinned files there), and one is offered only once the Remote
 * says it has it: without either the section is not shown.
 */
export function desktopApp(): HTMLElement {
  const section = h('section', {class: 'section runtime-desktop', 'aria-labelledby': 'app-title', hidden: ''});
  const pins = (desktopPins as Record<string, Partial<Record<'deb' | 'appimage', {file: string; bytes: number}>>>)[INSTALLER_RELEASE] ?? {};
  const url = (file: string) => `${REMOTE_URL}/v1/desktop/${encodeURIComponent(file)}`;
  const there = async (file: string) => { try { return (await fetch(url(file), {method: 'HEAD'})).ok; } catch { return false; } };
  void (async () => {
    const deb = pins.deb && (await there(pins.deb.file)) ? pins.deb : null;
    const first = deb ?? (pins.appimage && (await there(pins.appimage.file)) ? pins.appimage : null);
    if (!first) return;
    const what = first === deb ? t('x86-64 Linux · .deb · {size}', {size: bytes(first.bytes)}) : t('x86-64 Linux · AppImage · {size}', {size: bytes(first.bytes)});
    const get = h('a', {class: 'button small-button download', href: url(first.file), download: first.file},
      mark('download'), h('span', {}, t('Download')));
    section.replaceChildren(h('h2', {id: 'app-title', class: 'runtime-group-heading'}, t('Desktop App')),
      h('div', {class: 'app-card'},
        h('div', {class: 'app-description'},
          h('span', {class: 'card-title'}, 'why*', ' ', h('span', {class: 'version'}, WHY_VERSION)),
          h('span', {class: 'muted small'}, what),
          h('span', {class: 'muted small'}, t('Installer from distribution release {version}', {version: INSTALLER_RELEASE}))),
        get));
    section.hidden = false;
  })();
  return section;
}
