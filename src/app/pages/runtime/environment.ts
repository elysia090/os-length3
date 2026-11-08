import {bytes, h} from '../../ui/dom.ts';
import {rootHere, rootStatus, rootUse, type RootStatus} from '../../host/host.ts';
import {t} from '../../i18n/i18n.ts';
import {about} from '../../prompt/userland.ts';
import {errorText} from '../../host/errors.ts';
import {button} from './parts.ts';

// Runtime's environments: the one a Prompt runs on, and the others it could.

/**
 * The environments a Prompt can run on, in one card: the one in effect at its
 * top (its name, its version in the mono face, what it is here, its digest),
 * then the others, a row each, quiet: Ubuntu and Debian (their makers' roots,
 * pinned by digest), and a root of one's own. In the app each other one can be
 * used with a press (Use, at its right): fetched if it is not here, then the
 * one Prompts run on, set up from .packages and .setup at the next Prompt. In
 * a browser only root3 runs (through xlat, which does not link programs as they
 * run); the others say where they do. Custom is not yet.
 */
export function environment(): HTMLElement {
  const card = h('div', {class: 'card small-card env-card'}, h('span', {class: 'muted small'}, t('Loading…')));
  const paint = async () => {
    const here = await rootHere();
    let root: Awaited<ReturnType<typeof rootStatus>> = null;
    try { root = here.native ? await rootStatus() : null; } catch (e) { card.replaceChildren(h('p', {class: 'error'}, errorText(e))); return; }
    if (root) { card.replaceChildren(...inTheApp(root, paint)); return; }
    let a: Awaited<ReturnType<typeof about>>;
    try { a = await about(); } catch (e) { card.replaceChildren(h('p', {class: 'error'}, errorText(e))); return; }
    // In the app on a machine Prompts do not run on the root, translated as in a browser: said, with why.
    card.replaceChildren(...onTheWeb(a), ...(here.why ? [h('p', {class: 'muted small env-why'}, t('Prompts run translated here: {why}', {why: here.why}))] : []));
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
const custom = () => other(t('Custom'), '', t('Custom root (.tar)'), h('span', {class: 'muted small'}, t('Not yet')));

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

/** In the app: the root in effect at the top (root3's or a distribution's), each other one with Use, and Custom. */
function inTheApp(root: RootStatus, again: () => void): Node[] {
  const now = root.current?.distro ?? (root.current ? 'root3' : null);
  const all = roots(root, now);
  const current = all.find((e) => e.id === now);
  return [...(current ? top(current.name, current.version, current.what, current.sha) : [h('span', {class: 'card-title'}, t('Active environment'))]),
    others(...all.filter((e) => e !== current).map((e) => { const note = h('span', {class: 'muted small env-note'}, e.what); return other(e.name, e.version, note, use(e.id, note, again)); }),
      custom())];
}

/** root3 and each distribution the app knows: its version, what it is (its size, when it is the one here), its digest. */
function roots(root: RootStatus, now: string | null) {
  const root3 = root.current && now === 'root3' ? root.current : null;
  return [
    {id: 'root3', name: 'root3', version: root3?.version ?? root.release.version, what: root3 ? t('{name} · {size}', {name: root3.name, size: bytes(root3.bytes)}) : root.release.name, sha: root3?.sha256 ?? ''},
    ...root.distros.map((d) => {
      const held = root.current?.distro === d.id ? root.current : null;
      return {id: d.id, name: d.name, version: d.version, what: held ? t('{name} · {size}', {name: d.name, size: bytes(held.bytes)}) : t('apt; provisioned via .packages and .setup'), sha: held?.sha256 ?? ''};
    })];
}

/** On the web: root3 at the top (`a`, as this build carries it), and the others, which run in the app. */
function onTheWeb(a: Awaited<ReturnType<typeof about>>): Node[] {
  // The same root3 as the app's: its version, and the digest of the root it is (src/core/src/root/), run here through xlat.
  // A build that carries no root3 says so in root3's own row: Ubuntu, Debian and Custom are under it all the same.
  return [...(a ? top('root3', a.version, t('{name} · via xlat', {name: a.root.name}), a.sha256)
    : top('root3', '', t('root3 missing (run: npm run webroot)'), '')),
  others(other('Ubuntu', '26.04.1 LTS', t('App only'), null),
    other('Debian', '13.7', t('App only'), null),
    custom())];
}
