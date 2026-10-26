import {ago, h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {shown as named, shownAs} from '../../remote/inbox.ts';
import * as servers from '../../remote/servers.ts';
import {button} from './parts.ts';
import {errorText} from '../../app/errors.ts';

/** Past this, a file shown is cut short. */
const SHOW_BYTES = 256 * 1024;

/**
 * A repo shown in a server, in the boards' place: seen as it was last
 * pushed, its files at the left and the one chosen at the right (its README
 * first). It is only seen there, never written; one's own opens in Forge.
 */
export async function seeRepo(sheet: HTMLElement, r: servers.ShownRepo, ways: {back(): void; forge(): void}) {
  const as = `${r.owner}:${r.name}`;
  const back = button(t('Back to the boards'), 'small-button');
  back.addEventListener('click', () => ways.back());
  const forge = r.mine ? button(t('Open in Forge'), 'small-button') : null;
  forge?.addEventListener('click', () => ways.forge());
  const sub = h('p', {class: 'muted small'}, '…');
  const files = h('ul', {class: 'seen-files', 'aria-label': t('Files')});
  const text = h('pre', {class: 'seen-text', tabindex: '0'});
  const body = h('div', {class: 'seen-body'}, files, text);
  sheet.replaceChildren(
    h('div', {class: 'sheet-head'}, h('div', {class: 'sheet-title'}, h('h2', {}, r.name), h('p', {}, named(r.owner))), h('span', {class: 'grow'}), forge, back),
    h('div', {class: 'sheet-sub'}, sub, r.as ? h('p', {class: 'muted small'}, t('Everyone sees it as {name}', {name: shownAs(r.as)})) : null),
    body);
  try {
    const got = await servers.seeRepo(as);
    sub.textContent = got.at ? t('Pushed {when}: {title}', {when: ago(got.at), title: got.title ?? ''}) : t('Nothing pushed yet');
    const paths = Object.entries(got.tree).filter(([, sha]) => sha !== null).map(([p]) => p).sort((a, b) => a.localeCompare(b));
    // Nothing pushed, nothing to read: the line says so, and no sheet of nothing stands under it.
    body.hidden = !paths.length;
    // The file chosen last is the one shown: an earlier one that answers after it is not drawn over it.
    let chosen = '';
    const open = async (path: string, row: HTMLElement) => {
      chosen = path;
      files.querySelectorAll('[aria-current]').forEach((x) => x.removeAttribute('aria-current'));
      row.setAttribute('aria-current', 'true');
      text.textContent = '…';
      let shown: string;
      try {
        const body = await servers.seeFile(as, path);
        shown = body.includes('\0') ? t('Not text') : body.length > SHOW_BYTES ? `${body.slice(0, SHOW_BYTES)}\n…` : body;
      } catch (e) { shown = errorText(e); }
      if (chosen !== path) return;
      text.textContent = shown;
      text.setAttribute('aria-label', path);
    };
    files.replaceChildren(...paths.map((path) => {
      const b = h('button', {type: 'button', class: 'seen-file mono small'}, path);
      b.addEventListener('click', () => void open(path, b));
      return h('li', {}, b);
    }));
    const first = paths.findIndex((p) => /^readme(\.|$)/i.test(p));
    const pick = first >= 0 ? first : 0;
    if (paths[pick]) void open(paths[pick], files.querySelectorAll('button')[pick] as HTMLElement);
  } catch (e) { sub.textContent = errorText(e); }
}
