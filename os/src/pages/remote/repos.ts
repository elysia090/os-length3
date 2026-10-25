import {ago, bytes, day, h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {bring, look, onSync, remoteAll, repoState} from '../../remote/lifecycle.ts';
import type {RemoteRepo} from '../../remote/sync.ts';
import * as account from '../../remote/connection.ts';
import {store} from '../../repos/repos.ts';
import {freeOff} from '../../app/space.ts';
import * as servers from '../../remote/servers.ts';
import type {Context} from '../context.ts';
import {summaryOf} from '../repo-list.ts';
import {button, message, pressing} from './parts.ts';
import {syncWord} from './repo-card.ts';
import {sharing} from './share.ts';
import {confirm, inTheBrowser, turningOff, type Ask} from './repo-off.ts';

// Remote's Repos: every repo, here and on the Remote, a card each; and the way to a repo's own card from a list.

/**
 * The repo to bring into view and light on Remote's Repos once they are drawn (openRepoPlace): kept a moment,
 * since the page draws the cards again as what the Remote says comes in, and the card lit is drawn anew.
 */
let lit: {name: string; until: number} | null = null;

/**
 * A repo's own place, where what is done to the repo itself is (its switch, who sees it, Forge): its card on
 * Remote, shown and lit. A list's repo body leads here (Home, Runtime). Signed out there is no card on a Remote
 * yet: the repo opens in Forge, where all of it is.
 */
export function openRepoPlace(ctx: Context, name: string) {
  if (!account.connection()) { ctx.openRepo(name); return; }
  lit = {name, until: Date.now() + 3000};
  try { localStorage.setItem('length3.part.remote', 'repos'); } catch { /* the part kept, then */ }
  ctx.go('remote');
}

/**
 * The repos the Remote holds, as cards the size of Home's: name, size and
 * when it last changed; Forge at the bottom left, who sees it beside it, and
 * at the right a power switch. Who sees it is one of three: only you, the
 * servers it is shown in, or everyone (seen as a server's when it goes
 * public from one, so it is not tied to you; as yours when you choose). Turning a repo off asks for a passkey, the account's name, the
 * repo's name and the five-letter code (set there and then if it is not yet);
 * it is then kept 30 days, its switch at the right and red, and pressing it
 * again brings it back at once. `keyed` hears of a passkey made on the way.
 */
export function repoSection(ctx: Context, counted: (n: number) => void, keyed: () => void, toPlan: () => void): HTMLElement {
  const grid = h('div', {class: 'grid repo-cards'});
  const said = h('p', {class: 'muted small asked-said', role: 'status'});
  const section = h('div', {class: 'sub-part'}, said, grid);
  // What the app asked this page to do at a repo's card (a passkey's deed): pressed for the person once the cards are drawn.
  let asked: {ask: account.BrowserAsk; repo: string | null} | null = null;
  let seen: servers.RepoSeen[] = [];
  // A card asking (or about to), or its Share list out, is not drawn over by a look that crossed the
  // press; what ends the ask draws them all (`ended`).
  const asking = () => !!grid.querySelector('.off-ask, [data-asking], .share-pop:not([hidden])');
  const paint = (force = false) => draw(force).catch((e) => grid.replaceChildren(h('p', {class: 'error'}, message(e))));
  const ended = () => paint(true);
  const draw = async (force: boolean) => {
    const here = await store.list();
    const there = remoteAll();
    // Who sees each is the Remote's to say: away, no Share is offered (the rail and the line above say why).
    seen = account.connection() ? await servers.seenAll().catch(() => []) : [];
    const names = [...new Set([...here.map((r) => r.name), ...there.map((r) => r.name)])].sort();
    counted(names.length);
    if (!force && asking()) return;
    grid.replaceChildren(...(names.length ? names.map((name) => card(name, here.find((r) => r.name === name) ?? null, there.find((r) => r.name === name) ?? null))
      : [h('div', {class: 'empty'}, t('No repos yet'))]));
    // Come to from a list's repo: its card in view, lit a moment, with the keyboard on it.
    if (lit && lit.until < Date.now()) lit = null;
    const at = lit ? grid.querySelector<HTMLElement>(`.card[data-repo="${CSS.escape(lit.name)}"]`) : null;
    if (at) {
      at.scrollIntoView({block: 'center'});
      at.classList.add('revealed');
      at.tabIndex = -1;
      // The keyboard on it, unless the person has put it somewhere since.
      const now = document.activeElement;
      if (!now || now === document.body || now.tagName === 'MAIN' || !now.isConnected || grid.contains(now)) at.focus({preventScroll: true});
      setTimeout(() => at.classList.remove('revealed'), 1600);
    }
  };
  const card = (name: string, here: {bytes: number; modified: number} | null, there: RemoteRepo | null): HTMLElement => {
    const off = !!there?.offAt;
    const error = h('p', {class: 'error', role: 'alert'});
    const size = there?.bytes ?? here?.bytes ?? 0;
    const changed = there ? Date.parse(there.updatedAt) : here?.modified ?? 0;
    // Away, the Remote can do nothing: what only it holds waits, and so does its switch.
    const gone = account.remoteAway();
    // On, the repo opens in Forge; off, what was Forge frees the copy here (the Remote keeps it 30 days).
    const forge = button(off ? t('Free') : t('Forge'), 'small-button');
    forge.disabled = gone && !here;
    if (off) {
      forge.hidden = !here;
      forge.title = t('The Remote keeps it until {date}; the copy here goes', {date: day(there!.until!)});
      forge.addEventListener('click', () => void pressing(forge, error, async () => { await freeOff(name); await paint(); }));
    } else forge.addEventListener('click', () => void pressing(forge, error, async () => { if (!here) await bring(name); ctx.openRepo(name); }));
    const power = h('button', {type: 'button', class: 'power', role: 'switch', 'aria-checked': String(!off),
      'aria-label': off ? t('Turn {repo} on', {repo: name}) : t('Turn {repo} off', {repo: name})}, h('span', {class: 'knob'})) as HTMLButtonElement;
    power.disabled = gone;
    const where = off
      ? t('Off · back until {date}', {date: day(there!.until!)})
      : here ? syncWord(repoState(name)) : t('Only on the Remote');
    // Held back by the plan: said where it stands, and the way to the Plan beside it.
    const waits = !off && here && repoState(name)?.where === 'waits';
    const plan = waits ? button(t('See the plan'), 'small-button') : null;
    plan?.addEventListener('click', toPlan);
    const who = seen.find((x) => x.name === name);
    const share = who && !off ? sharing(who, error) : null;
    // Off, beside 空ける: 廃棄, which takes it from the Remote now, for good, asked for as turning it off was.
    const discard = off ? h('button', {type: 'button', class: 'button small-button discard'}, t('Discard')) as HTMLButtonElement : null;
    if (discard) discard.disabled = gone;
    // A group named by its repo, so what is in it (its switch, Share, Forge) is heard as the repo's.
    // What it is, as Home's card says it, once read (only a copy here can be read).
    const what = h('span', {class: 'card-summary'});
    if (here) void summaryOf(name).then((line) => { what.textContent = line; }, () => {});
    const el = h('div', {class: `card repo${off ? ' off' : ''}`, 'data-repo': name, role: 'group', 'aria-label': name},
      h('span', {class: 'card-title'}, name), what,
      h('span', {class: 'muted'}, `${bytes(size)} · ${t('Changed {when}', {when: ago(changed)})}`),
      h('span', {class: 'muted card-sync'}, where),
      // What one does with the repo goes at the left: Forge (which leaves for another page) and Share beside
      // it, its servers coming out to its right. The switch keeps the right end; turned off, it makes Forge
      // 空ける in the same place, 廃棄 beside it.
      h('div', {class: 'card-foot'}, forge, discard, share, plan, h('span', {class: 'grow'}), power), error);
    // Asked of this page by the app (…/?account=off&repo=NAME): once it is done, said here, and that the app shows it.
    const over = (kind: 'off' | 'discard') => (asked?.repo === name && asked.ask === kind ? () => ended().then(() => {
      const now = remoteAll().find((r) => r.name === name);
      if (kind === 'off' ? now?.offAt : !now) { asked = null; said.textContent = t('Done. Go back to the app: it shows it there.'); }
    }) : ended);
    power.addEventListener('click', () => {
      if (off) { void pressing(power, error, async () => { await account.turnOn(name); await look(); await paint(); }); return; }
      // Asking from now on, before the ask is drawn: the cards are not drawn again under it meanwhile.
      el.dataset.asking = '';
      if (account.deedsHere()) void confirm(el, power, name, turningOff(name), over('off'), keyed);
      else inTheBrowser(el, power, name, 'off', turningOff(name), ended);
    });
    discard?.addEventListener('click', () => {
      el.dataset.asking = '';
      const ask: Ask = {
        verb: t('Discard'),
        what: [t('It goes from the Remote now, with its history, and cannot be brought back.'), ...(here ? [t('The copy here goes with it.')] : [])],
        // The copy here first: one holding what the Remote lacks is kept, and nothing is discarded.
        act: async (who, typed, code, proven) => { if (here) await freeOff(name); await account.discard(name, who, typed, code, proven); },
      };
      if (account.deedsHere()) void confirm(el, discard, name, ask, over('discard'), keyed);
      else inTheBrowser(el, discard, name, 'discard', ask, ended);
    });
    return el;
  };
  void look().then(() => paint()).then(settled).then(() => {
    // Taken by the section on screen once the page has settled: the first page is drawn again as what the Remote
    // has comes in, and the one drawn before it is gone.
    if (!section.isConnected) return;
    const a = account.takeAsk();
    asked = a && a.ask !== 'sign-in' && a.repo ? a : null;
    if (!asked) return;
    const at = grid.querySelector<HTMLElement>(`.card[data-repo="${CSS.escape(asked.repo!)}"]`);
    const press = at?.querySelector<HTMLButtonElement>(asked.ask === 'off' ? '.power[aria-checked="true"]' : '.discard');
    if (press && !press.disabled) { at!.scrollIntoView({block: 'center'}); press.click(); return; }
    said.textContent = asked.ask === 'off' ? t('{repo} is not on here to turn off: it is off already, or on another account.', {repo: asked.repo!})
      : t('{repo} is not here to discard: it is gone already, on, or on another account.', {repo: asked.repo!});
    asked = null;
  });
  const again = () => { if (!section.isConnected) { stop(); unreach(); return; } void paint(); };
  const stop = onSync(again);
  const unreach = account.onReach(again);
  return section;
}

/** Once the first page is drawn from what the Remote has (main.ts: no longer busy). */
function settled(): Promise<void> {
  const page = document.getElementById('page');
  return new Promise((done) => {
    if (!page?.hasAttribute('aria-busy')) { done(); return; }
    new MutationObserver((_, o) => { if (!page.hasAttribute('aria-busy')) { o.disconnect(); done(); } }).observe(page, {attributes: true, attributeFilter: ['aria-busy']});
  });
}
