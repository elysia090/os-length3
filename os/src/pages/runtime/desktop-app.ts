import {bytes, h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {REMOTE_URL} from '../../remote/connection.ts';
import {mark} from '../../ui/icons.ts';
import desktopPins from '../../../shared/desktop-releases.json' with {type: 'json'};

// Runtime's desktop app, offered on the web beside the environments: the app itself is it.

/** The release this build ships (the newest pinned, through vite.config.ts). */
const RELEASE = (import.meta as {env?: Record<string, string>}).env?.VITE_LENGTH3_RELEASE ?? '';

/**
 * The desktop app, on the web only: one small card, saying what it is (Length³,
 * its version apart in the mono face) and which file with its size, and
 * Download (its icon and the word, a size smaller than a small button) at its
 * bottom left, as a deed that leaves the page for this computer. Download
 * gives the .deb (Debian, Ubuntu: most of x86-64 Linux), or the AppImage when
 * the Remote has no .deb; one download only. Both come from the Remote (the
 * deploy puts the pinned files there), and one is offered only once the Remote
 * says it has it: without either the section is not shown.
 */
export function desktopApp(): HTMLElement {
  const section = h('section', {class: 'section', 'aria-labelledby': 'app-title', hidden: ''});
  const pins = (desktopPins as Record<string, Partial<Record<'deb' | 'appimage', {file: string; bytes: number}>>>)[RELEASE] ?? {};
  const url = (file: string) => `${REMOTE_URL}/v1/desktop/${encodeURIComponent(file)}`;
  const there = async (file: string) => { try { return (await fetch(url(file), {method: 'HEAD'})).ok; } catch { return false; } };
  void (async () => {
    const deb = pins.deb && (await there(pins.deb.file)) ? pins.deb : null;
    const first = deb ?? (pins.appimage && (await there(pins.appimage.file)) ? pins.appimage : null);
    if (!first) return;
    const what = first === deb ? t('x86-64 Linux · .deb · {size}', {size: bytes(first.bytes)}) : t('x86-64 Linux · AppImage · {size}', {size: bytes(first.bytes)});
    const get = h('a', {class: 'button primary small-button download', href: url(first.file), download: first.file, title: `${first.file} · ${bytes(first.bytes)}`},
      mark('download'), h('span', {}, t('Download')));
    // Beside the environments, the same small card: what it is, which file and its size, and Download at its bottom left.
    section.replaceChildren(h('h2', {id: 'app-title'}, t('Desktop app')),
      h('div', {class: 'card small-card app-card'},
        // The product's name, and its version apart: a name and a number are two things.
        h('span', {class: 'card-title'}, 'Length³', ' ', h('span', {class: 'version'}, RELEASE)),
        h('span', {class: 'muted small'}, what),
        h('div', {class: 'card-foot'}, get, h('span', {class: 'grow'}))));
    section.hidden = false;
  })();
  return section;
}
