import {ago, bytes, day, h} from '../../ui/dom.ts';
import {t, tn} from '../../i18n.ts';
import {bring, look, repoState, type RepoSync} from '../../remote/lifecycle.ts';
import type {RemoteRepo} from '../../remote/sync.ts';
import * as account from '../../remote/connection.ts';
import {freeOff} from '../../app/space.ts';
import type * as servers from '../../remote/servers.ts';
import {summaryOf} from '../repo-list.ts';
import {button, pressing} from './parts.ts';
import {sharing} from './share.ts';
import {askFirst, type AskWays, type Deed} from './repo-off.ts';

// A repo as Remote's Repos shows it, and where it stands, in the words every list of repos uses (Home, Runtime).

/** Where a repo stands, in words. */
export function syncWord(s: RepoSync | undefined): string {
  if (!s) return '';
  if (s.where === 'local') return t('Only on this device');
  if (s.where === 'off') return t('Off on the Remote');
  if (s.where === 'waits') return t('Kept here · waits for room on the Remote');
  if (s.where === 'sending') return t('Sending');
  if (s.where === 'offline') {
    const not = s.changed ? tn('Not sent yet ({n} change)', 'Not sent yet ({n} changes)', s.changed) : t('Not sent yet');
    // Why, as the Remote (or this browser) said it: not reached, full, too large.
    return s.error ? `${not} · ${s.error}` : not;
  }
  if (s.unsynced.length) return tn('In step · {n} thing cannot be sent', 'In step · {n} things cannot be sent', s.unsynced.length);
  return t('In step');
}

/** The copy of a repo on this device, as the store lists it. */
interface Here { bytes: number; modified: number }

/** What a repo's card asks of the Repos it stands in. */
export interface CardWays {
  /** Open it in Forge. */
  forge(name: string): void;
  /** Remote's Plan, for a repo the plan holds back. */
  toPlan(): void;
  /** The cards drawn again, as they are now. */
  paint(): Promise<void>;
  /** How an ask of `kind` at `name`'s card ends. */
  ends(name: string, kind: Deed): AskWays;
}

/**
 * The card of `name`, with the copy here and the Remote's as they are (either may be missing) and who sees it
 * (`who`, as the Remote says; none, and there is no Share): its name, what it is, its size and when it changed,
 * where it stands; Forge and Share at its foot's left and its switch at the right. Off, Forge frees the copy here
 * (空ける) and Discard (廃棄) stands beside it.
 */
export function repoCard(name: string, here: Here | null, there: RemoteRepo | null, who: servers.RepoSeen | undefined, w: CardWays): HTMLElement {
  const off = !!there?.offAt;
  const error = h('p', {class: 'error', role: 'alert'});
  // Away, the Remote can do nothing: what only it holds waits, and so does its switch.
  const gone = account.remoteAway();
  const forge = forgeButton(name, here, there, gone, error, w);
  const power = h('button', {type: 'button', class: 'power', role: 'switch', 'aria-checked': String(!off),
    'aria-label': off ? t('Turn {repo} on', {repo: name}) : t('Turn {repo} off', {repo: name})}, h('span', {class: 'knob'})) as HTMLButtonElement;
  power.disabled = gone;
  // Held back by the plan: said where it stands, and the way to the Plan beside it.
  const plan = !off && here && repoState(name)?.where === 'waits' ? button(t('See the plan'), 'small-button') : null;
  plan?.addEventListener('click', w.toPlan);
  const share = who && !off ? sharing(who, error) : null;
  // Off, beside 空ける: 廃棄, which takes it from the Remote now, for good, asked for as turning it off was.
  const discard = off ? h('button', {type: 'button', class: 'button small-button discard'}, t('Discard')) as HTMLButtonElement : null;
  if (discard) discard.disabled = gone;
  // A group named by its repo, so what is in it (its switch, Share, Forge) is heard as the repo's.
  const el = h('div', {class: `card repo${off ? ' off' : ''}${plan ? ' held' : ''}`, 'data-repo': name, role: 'group', 'aria-label': name},
    h('span', {class: 'card-title'}, name), summary(name, here), ...facts(name, here, there),
    // What one does with the repo goes at the left: Forge (which leaves for another page) and Share beside
    // it, its servers coming out to its right. The switch keeps the right end; turned off, it makes Forge
    // 空ける in the same place, 廃棄 beside it.
    h('div', {class: 'card-foot'}, forge, discard, share, plan, h('span', {class: 'grow'}), power), error);
  const ask = (from: HTMLButtonElement, kind: Deed) => {
    // Asking from now on, before the ask is drawn: the cards are not drawn again under it meanwhile.
    el.dataset.asking = '';
    askFirst(el, from, name, kind, !!here, w.ends(name, kind));
  };
  power.addEventListener('click', () => {
    if (!off) { ask(power, 'off'); return; }
    void pressing(power, error, async () => { await account.turnOn(name); await look(); await w.paint(); });
  });
  discard?.addEventListener('click', () => ask(discard, 'discard'));
  return el;
}

/** On, the repo opens in Forge; off, what was Forge frees the copy here (the Remote keeps it 30 days). */
function forgeButton(name: string, here: Here | null, there: RemoteRepo | null, gone: boolean, error: HTMLElement, w: CardWays): HTMLButtonElement {
  const off = !!there?.offAt;
  const forge = button(off ? t('Free') : t('Forge'), 'small-button');
  forge.disabled = gone && !here;
  if (off) {
    forge.hidden = !here;
    forge.title = t('The Remote keeps it until {date}; the copy here goes', {date: day(there!.until!)});
    forge.addEventListener('click', () => void pressing(forge, error, async () => { await freeOff(name); await w.paint(); }));
  } else forge.addEventListener('click', () => void pressing(forge, error, async () => { if (!here) await bring(name); w.forge(name); }));
  return forge;
}

/** What it is, as Home's card says it, once read (only a copy here can be read). */
function summary(name: string, here: Here | null): HTMLElement {
  const what = h('span', {class: 'card-summary'});
  if (here) void summaryOf(name).then((line) => { what.textContent = line; }, () => {});
  return what;
}

/** Its size and when it last changed, and where it stands. */
function facts(name: string, here: Here | null, there: RemoteRepo | null): Node[] {
  const size = there?.bytes ?? here?.bytes ?? 0;
  const changed = there ? Date.parse(there.updatedAt) : here?.modified ?? 0;
  const where = there?.offAt
    ? t('Off · back until {date}', {date: day(there.until!)})
    : here ? syncWord(repoState(name)) : t('Only on the Remote');
  return [h('span', {class: 'muted'}, `${bytes(size)} · ${t('Changed {when}', {when: ago(changed)})}`),
    h('span', {class: 'muted card-sync'}, where)];
}
