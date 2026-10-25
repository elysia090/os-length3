import {bytes, h} from '../../ui/dom.ts';
import {isNative, rootStatus, rootUse, type RootStatus} from '../../app/host.ts';
import {t} from '../../i18n.ts';
import {about} from '../../prompt/userland.ts';
import {errorText} from '../../app/errors.ts';
import {button} from './parts.ts';

// Runtime's environments: the one a Prompt runs on, and the others it could.

/**
 * The environments a Prompt can run on, in one card: the one in effect at its
 * top (its name, its version in the mono face, what it is here, its digest),
 * then the others, a row each, quiet: Ubuntu and Debian (their makers' roots,
 * pinned by digest), and a root of one's own. In the app each other one can be
 * used with a press (Use, at its right): fetched if it is not here, then the
 * one Prompts run on, set up from .packages and .setup at the next Prompt. In
 * a browser only l3 runs (through xlat, which does not link programs as they
 * run); the others say where they do. Custom is not yet.
 */
export function environment(): HTMLElement {
  const card = h('div', {class: 'card small-card env-card'}, h('span', {class: 'muted small'}, t('Reading…')));
  const paint = async () => {
    let root: Awaited<ReturnType<typeof rootStatus>> = null;
    try { root = await rootStatus(); } catch (e) { card.replaceChildren(h('p', {class: 'error'}, errorText(e))); return; }
    if (isNative && root) { card.replaceChildren(...inTheApp(root, paint)); return; }
    let a: Awaited<ReturnType<typeof about>>;
    try { a = await about(); } catch (e) { card.replaceChildren(h('p', {class: 'error'}, errorText(e))); return; }
    card.replaceChildren(...onTheWeb(a));
  };
  void paint();
  return card;
}

const version = (v: string) => (v ? h('span', {class: 'version'}, v) : null);

/** The one in effect: the card's head. */
const top = (name: string, v: string, note: string, sha: string) => [
  h('span', {class: 'card-title'}, name, ' ', version(v)), h('span', {class: 'muted small'}, note),
  ...(sha ? [h('code', {class: 'muted small env-sha', title: sha}, sha.slice(0, 12))] : [])];

/** Another: its name and version, what it is (or its state), and at its right what can be done (or nothing). */
const other = (name: string, v: string, note: string | Node, end: Node | null) =>
  h('div', {class: 'env-row', role: 'listitem'}, h('span', {class: 'env-name'}, name, ' ', version(v)),
    typeof note === 'string' ? h('span', {class: 'muted small env-note'}, note) : note, end);

const others = (...rows: HTMLElement[]) => h('div', {class: 'env-rows', role: 'list', 'aria-label': t('Other environments')}, ...rows);

/** A root of one's own: not yet. */
const custom = () => other(t('Custom'), '', t('Your own root (.tar)'), h('span', {class: 'muted small'}, t('Not yet')));

/** Pressed: fetched if it is not here, then the one in effect; its progress said in `note`, the card drawn again (`again`) once it is. */
function use(id: string, note: HTMLElement, again: () => void): HTMLButtonElement {
  const b = button(t('Use'), 'small-button');
  b.addEventListener('click', () => {
    b.disabled = true;
    void rootUse(id, (got, of, retry) => {
      note.textContent = retry ?? t('Fetching {got} / {of}', {got: bytes(got), of: bytes(of)});
    }).then(() => again(), (e) => { note.textContent = errorText(e); b.disabled = false; });
  });
  return b;
}

/** In the app: the root in effect at the top (l3's or a distribution's), each other one with Use, and Custom. */
function inTheApp(root: RootStatus, again: () => void): Node[] {
  const now = root.current?.distro ?? (root.current ? 'l3' : null);
  const all = roots(root, now);
  const current = all.find((e) => e.id === now);
  return [...(current ? top(current.name, current.version, current.what, current.sha) : [h('span', {class: 'card-title'}, t('Environment in effect'))]),
    others(...all.filter((e) => e !== current).map((e) => { const note = h('span', {class: 'muted small env-note'}, e.what); return other(e.name, e.version, note, use(e.id, note, again)); }),
      custom())];
}

/** l3 and each distribution the app knows: its version, what it is (its size, when it is the one here), its digest. */
function roots(root: RootStatus, now: string | null) {
  const l3 = root.current && now === 'l3' ? root.current : null;
  return [
    {id: 'l3', name: 'l3', version: l3?.version ?? root.release.version, what: l3 ? t('{name} · {size}', {name: l3.name, size: bytes(l3.bytes)}) : root.release.name, sha: l3?.sha256 ?? ''},
    ...root.distros.map((d) => {
      const held = root.current?.distro === d.id ? root.current : null;
      return {id: d.id, name: d.name, version: d.version, what: held ? t('{name} · {size}', {name: d.name, size: bytes(held.bytes)}) : t('apt; .packages and .setup set it up'), sha: held?.sha256 ?? ''};
    })];
}

/** On the web: l3 at the top (`a`, as this build carries it), and the others, which run in the app. */
function onTheWeb(a: Awaited<ReturnType<typeof about>>): Node[] {
  // The same l3 as the app's: its version, and the digest of the root it is (core/src/root.rs), run here through xlat.
  // A build that carries no l3 says so in l3's own row: Ubuntu, Debian and Custom are under it all the same.
  return [...(a ? top('l3', a.version, t('{name} · through xlat', {name: a.root.name}), a.sha256)
    : top('l3', '', t('There is no l3 (npm run l3)'), '')),
  others(other('Ubuntu', '24.04.5 LTS', t('In the app only'), null),
    other('Debian', '13', t('In the app only'), null),
    custom())];
}
