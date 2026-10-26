import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {look, onSync, remoteAll} from '../../remote/lifecycle.ts';
import * as account from '../../remote/connection.ts';
import {store} from '../../repos/repos.ts';
import * as servers from '../../remote/servers.ts';
import {choosePart} from '../common.ts';
import type {Context} from '../context.ts';
import {errorText} from '../../app/errors.ts';
import {repoCard, type CardWays} from './repo-card.ts';
import {doneTo, type AskWays, type Deed} from './repo-off.ts';

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
  choosePart('remote', 'repos');
  ctx.go('remote');
}

/** A card of `grid` by its repo's name. */
const cardOf = (grid: HTMLElement, name: string) => grid.querySelector<HTMLElement>(`.card[data-repo="${CSS.escape(name)}"]`);

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
  // A card asking (or about to), or its Share list out, is not drawn over by a look that crossed the
  // press; what ends the ask draws them all (`ended`).
  const asking = () => !!grid.querySelector('.off-ask, [data-asking], .share-pop:not([hidden])');
  const paint = (force = false) => draw(force).catch((e) => grid.replaceChildren(h('p', {class: 'error'}, errorText(e))));
  const ended = () => paint(true);
  // Asked of this page by the app (…/?account=off&repo=NAME): once it is done, said here, and that the app shows it.
  const over = (name: string, kind: Deed) => (asked?.repo === name && asked.ask === kind ? () => ended().then(() => {
    if (doneTo(name, kind)) { asked = null; said.textContent = t('Done. Go back to the app: it shows it there.'); }
  }) : ended);
  const ways: CardWays = {
    forge: (name) => ctx.openRepo(name), toPlan, paint: () => paint(),
    ends: (name, kind): AskWays => ({done: over(name, kind), ended, keyed}),
  };
  const draw = async (force: boolean) => {
    const here = await store.list();
    const there = remoteAll();
    // Who sees each is the Remote's to say: away, no Share is offered (the rail and the line above say why).
    const seen = account.connection() ? await servers.seenAll().catch(() => []) : [];
    const names = [...new Set([...here.map((r) => r.name), ...there.map((r) => r.name)])].sort();
    counted(names.length);
    if (!force && asking()) return;
    grid.replaceChildren(...(names.length ? names.map((name) => repoCard(name, here.find((r) => r.name === name) ?? null,
      there.find((r) => r.name === name) ?? null, seen.find((x) => x.name === name), ways))
      : [h('div', {class: 'empty'}, t('No repos yet'))]));
    showLit(grid);
  };
  // Taken by the section on screen once the page has settled: the first page is drawn again as what the Remote
  // has comes in, and the one drawn before it is gone.
  const pressAsked = () => {
    if (!section.isConnected) return;
    const a = account.takeAsk();
    asked = a && a.ask !== 'sign-in' && a.repo ? a : null;
    if (!asked) return;
    const at = cardOf(grid, asked.repo!);
    const press = at?.querySelector<HTMLButtonElement>(asked.ask === 'off' ? '.power[aria-checked="true"]' : '.discard');
    if (press && !press.disabled) { at!.scrollIntoView({block: 'center'}); press.click(); return; }
    said.textContent = asked.ask === 'off' ? t('{repo} is not on here to turn off: it is off already, or on another account.', {repo: asked.repo!})
      : t('{repo} is not here to discard: it is gone already, on, or on another account.', {repo: asked.repo!});
    asked = null;
  };
  void look().then(() => paint()).then(settled).then(pressAsked);
  const again = () => { if (!section.isConnected) { stop(); unreach(); return; } void paint(); };
  const stop = onSync(again);
  const unreach = account.onReach(again);
  return section;
}

/** Come to from a list's repo: its card in view, lit a moment, with the keyboard on it. */
function showLit(grid: HTMLElement) {
  if (lit && lit.until < Date.now()) lit = null;
  const at = lit ? cardOf(grid, lit.name) : null;
  if (!at) return;
  at.scrollIntoView({block: 'center'});
  at.classList.add('revealed');
  at.tabIndex = -1;
  // The keyboard on it, unless the person has put it somewhere since.
  const now = document.activeElement;
  if (!now || now === document.body || now.tagName === 'MAIN' || !now.isConnected || grid.contains(now)) at.focus({preventScroll: true});
  setTimeout(() => at.classList.remove('revealed'), 1600);
}

/** Once the first page is drawn from what the Remote has (main.ts: no longer busy). */
function settled(): Promise<void> {
  const page = document.getElementById('page');
  return new Promise((done) => {
    if (!page?.hasAttribute('aria-busy')) { done(); return; }
    new MutationObserver((_, o) => { if (!page.hasAttribute('aria-busy')) { o.disconnect(); done(); } }).observe(page, {attributes: true, attributeFilter: ['aria-busy']});
  });
}
