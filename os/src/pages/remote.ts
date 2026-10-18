import {ago, bytes, day, h} from '../dom.ts';
import {isNative} from '../host.ts';
import {mark} from '../icons.ts';
import {t, tn} from '../i18n.ts';
import {bring, look, onSync, remoteAll, repoState, type RepoSync} from '../lifecycle.ts';
import type {RemoteRepo} from '../draft.ts';
import * as account from '../remote.ts';
import {openPlan, plan as readPlan, planRefusal, planView, refusalWords, type PlanRefusal} from '../plan.ts';
import {store} from '../repos.ts';
import {freeOff} from '../space.ts';
import * as servers from '../servers.ts';
import {answers, askFoot, pageHead, parts, SETTLE} from './common.ts';
import type {Context} from './context.ts';

/** Remote's page, at its Plan part: where a place refused for the plan's sake leads. */
export function goToPlan(ctx: Context) {
  try { localStorage.setItem('length3.part.remote', 'plan'); } catch { /* the Repos part, then */ }
  ctx.go('remote');
}

/**
 * Said in place where the Remote refused for the plan's sake: what is paid, what happens to the work, and the
 * way to the Plan (`go`). Anything else, null: the place says it as it says any failure.
 */
export function planRefused(e: unknown, go: () => void): HTMLElement | null {
  const r = planRefusal(e);
  return r ? planSaid(r, go) : null;
}

/** What the plan says of `r` (refused, or known before anything is asked), with See the plan after it: the sentence whole, the button beside it or under it. */
export function planSaid(r: PlanRefusal, go: () => void): HTMLElement {
  const to = h('button', {type: 'button', class: 'button small-button'}, t('See the plan')) as HTMLButtonElement;
  to.addEventListener('click', go);
  return h('span', {class: 'plan-refused'}, h('span', {}, refusalWords(r)), to);
}

// Remote: where one's repos are kept, and who this device is there.
//
// Not signed in: one sentence on what it means, and the ways in. A browser
// signs in with GitHub, Google or Apple, or with a passkey it already has; the app
// and l3 show a code that a browser approves.
//
// Signed in: the repos, here and on the Remote only, each with where it
// stands; then what keeps the account: passkeys, the providers it can sign
// in with, the devices.

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

function button(text: string, kind = ''): HTMLButtonElement {
  return h('button', {class: `button ${kind}`.trim(), type: 'button'}, text) as HTMLButtonElement;
}

/** Run `f` with `b` pressed down, saying any failure in `error`. */
async function pressing(b: HTMLButtonElement, error: HTMLElement, f: () => Promise<void>) {
  b.disabled = true;
  error.textContent = '';
  try { await f(); } catch (e) { error.textContent = message(e); } finally { b.disabled = false; }
}

/**
 * The ways in. On the web: a provider, or a passkey. In the app: a code
 * approved in the browser. `done` runs once this device is in; a provider
 * leaves the page and comes back to `back`.
 */
/**
 * Signing in, the first thing a person meets: one place in the middle of the
 * page, as the current issue card is (an ink edge over raised, its weight a
 * little high), the ways in one under another.
 */
export function signInPlace(title: string, ...body: Node[]): HTMLElement {
  return h('div', {class: 'sign-in-place'},
    h('section', {class: 'sign-in-card', 'aria-labelledby': 'sign-in-title'}, h('h2', {id: 'sign-in-title'}, title), ...body));
}

/** The ways in, under the card's title and nothing else: the buttons say it. */
export function signInBox(done: () => void, back?: string): HTMLElement {
  const error = h('p', {class: 'error', role: 'alert'});
  const box = h('div', {class: 'remote-join'});
  if (isNative) {
    const go = button(t('Sign in in the browser'), 'primary');
    const waiting = h('div', {class: 'remote-join', hidden: ''});
    go.addEventListener('click', () => void pressing(go, error, async () => {
      const s = await account.appSignIn();
      waiting.hidden = false;
      waiting.replaceChildren(
        h('p', {}, t('In the browser that opened, check that it shows this code, then approve.')),
        h('p', {class: 'device-code mono'}, s.code),
        h('p', {class: 'muted small'}, s.url));
      go.hidden = true;
      await s.wait.finally(() => { go.hidden = false; waiting.hidden = true; });
      done();
    }));
    box.append(h('div', {class: 'row sign-in-row'}, go), waiting, error);
    return box;
  }
  const providers = h('div', {class: 'row sign-in-row'});
  const passkey = button(t('Sign in with a passkey'));
  const ways = () => void account.about().then(({providers: list, enter}) => {
    // Entered by a link alone: no provider, no passkey, and the card says where the way in is.
    passkey.hidden = !!enter;
    providers.replaceChildren(...list.map((p, i) => {
      const b = button(t('Continue with {name}', {name: account.PROVIDER_NAME[p]}), i === 0 ? 'primary' : '');
      b.addEventListener('click', () => void pressing(b, error, () => account.signInWith(p, back)));
      return b;
    }));
    // No ways because it did not answer is not the same as none offered; the ways come once it answers.
    if (!list.length) providers.replaceChildren(h('span', {class: 'muted'}, account.remoteAway() ? t('The Remote cannot be reached')
      : enter ? t('This Remote is entered by the link you were given.') : t('This Remote offers no way to sign in yet.')));
  });
  ways();
  const stop = account.onReach(() => { if (!box.isConnected) { stop(); return; } if (!account.remoteAway()) ways(); });
  // Back from a provider without a session: why, once.
  error.textContent = account.takeSignInTrouble();
  passkey.addEventListener('click', () => void pressing(passkey, error, async () => { await account.signIn(); done(); }));
  box.append(providers, h('div', {class: 'row sign-in-row'}, passkey), error);
  return box;
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
function repoSection(ctx: Context, counted: (n: number) => void, keyed: () => void, toPlan: () => void): HTMLElement {
  const grid = h('div', {class: 'grid repo-cards'});
  const section = h('div', {class: 'sub-part'}, grid);
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
    const el = h('div', {class: `card repo${off ? ' off' : ''}`, 'data-repo': name, role: 'group', 'aria-label': name},
      h('span', {class: 'card-title'}, name),
      h('span', {class: 'muted'}, `${bytes(size)} · ${t('Changed {when}', {when: ago(changed)})}`),
      h('span', {class: 'muted card-sync'}, where),
      // What one does with the repo goes at the left: Forge (which leaves for another page) and Share beside
      // it, its servers coming out to its right. The switch keeps the right end; turned off, it makes Forge
      // 空ける in the same place, 廃棄 beside it.
      h('div', {class: 'card-foot'}, forge, discard, share, plan, h('span', {class: 'grow'}), power), error);
    power.addEventListener('click', () => {
      if (off) { void pressing(power, error, async () => { await account.turnOn(name); await look(); await paint(); }); return; }
      if (isNative) { error.textContent = t('A repo is turned off from the browser, where its passkey is.'); return; }
      // Asking from now on, before the ask is drawn: the cards are not drawn again under it meanwhile.
      el.dataset.asking = '';
      void confirm(el, power, name, turningOff(name), ended, keyed);
    });
    discard?.addEventListener('click', () => {
      if (isNative) { error.textContent = t('A repo is discarded from the browser, where its passkey is.'); return; }
      el.dataset.asking = '';
      void confirm(el, discard, name, {
        verb: t('Discard'),
        what: [t('It goes from the Remote now, with its history, and cannot be brought back.'), ...(here ? [t('The copy here goes with it.')] : [])],
        // The copy here first: one holding what the Remote lacks is kept, and nothing is discarded.
        act: async (who, typed, code, proven) => { if (here) await freeOff(name); await account.discard(name, who, typed, code, proven); },
      }, ended, keyed);
    });
    return el;
  };
  void look().then(() => paint());
  const again = () => { if (!section.isConnected) { stop(); unreach(); return; } void paint(); };
  const stop = onSync(again);
  const unreach = account.onReach(again);
  return section;
}

/**
 * Share: as the language is chosen in the person's menu, it opens into a
 * list over the card, one row per server one is in, the ones the repo is
 * shown in bold; pressing one shows it there or takes it off at once, and
 * the list stays open for the next. It goes on a press outside, Escape or
 * Share again. Going public is the server's (its gear); it stays as it is here.
 */
function sharing(now: servers.RepoSeen, error: HTMLElement): HTMLElement {
  const open = h('button', {type: 'button', class: 'button small-button share-open', 'aria-haspopup': 'true', 'aria-expanded': 'false'},
    t('Share'), mark('down')) as HTMLButtonElement;
  const list = h('div', {class: 'pop share-pop', role: 'menu', 'aria-label': t('Share'), hidden: ''});
  let shared = new Set(now.servers.map((x) => x.id));
  const toggle = async (id: string) => {
    const next = new Set(shared);
    if (next.has(id)) next.delete(id); else next.add(id);
    const ids = [...next];
    // Public as a server it leaves: no longer public. Public otherwise: kept, with the new list.
    const r = now.seen === 'everyone' && !(now.asServer && !next.has(now.asServer))
      ? await servers.setSeen(now.name, 'everyone', {servers: ids, as: now.asServer ?? 'me'})
      : await servers.setSeen(now.name, ids.length ? 'servers' : 'private', ids.length ? {servers: ids} : {});
    now = r;
    shared = next;
  };
  const holder = h('span', {class: 'share'}, open, list);
  const away = (e: Event) => {
    if (e instanceof KeyboardEvent ? e.key === 'Escape' : !holder.contains(e.target as Node)) { show(false); if (e instanceof KeyboardEvent) open.focus(); }
  };
  const show = (out: boolean) => {
    list.hidden = !out;
    open.setAttribute('aria-expanded', String(out));
    for (const k of ['pointerdown', 'keydown'] as const) (out ? document.addEventListener : document.removeEventListener).call(document, k, away);
  };
  const fill = async () => {
    let mine: servers.Server[];
    // Not read (away): said in the list, and read again the next time it opens.
    try { mine = await servers.servers(); } catch (e) { list.replaceChildren(h('p', {class: 'error small pop-note'}, message(e))); return; }
    const rows = mine.map((s) => {
      const b = h('button', {type: 'button', class: 'pop-item', role: 'menuitemcheckbox', 'aria-checked': String(shared.has(s.id))}, s.name) as HTMLButtonElement;
      b.addEventListener('click', () => void pressing(b, error, async () => { await toggle(s.id); b.setAttribute('aria-checked', String(shared.has(s.id))); }));
      return b;
    });
    list.replaceChildren(h('div', {class: 'pop-group', role: 'group', 'aria-label': t('Shown in')},
      h('div', {class: 'pop-head muted small'}, t('Shown in')), ...(rows.length ? rows : [h('p', {class: 'muted small pop-note'}, t('In no server yet'))])));
  };
  open.addEventListener('click', async (event) => {
    if (!list.hidden) { show(false); return; }
    show(true);
    await fill();
    // Opened from the keyboard, the keyboard goes in with it.
    if (event.detail === 0) list.querySelector<HTMLElement>('.pop-item')?.focus();
  });
  list.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...list.querySelectorAll<HTMLElement>('.pop-item:not([disabled])')];
    if (!items.length) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
  });
  return holder;
}

/**
 * What is asked for in the card before a repo is turned off or discarded: the deed's word, what will happen, and
 * the deed (`proven`: a passkey confirmed it was you a moment ago, setting the code, so it is not asked again).
 */
interface Ask { verb: string; what: string[]; act(name: string, typed: string, code: string, proven: boolean): Promise<unknown> }
const turningOff = (repo: string): Ask => ({
  verb: t('Turn off'),
  what: [t('Kept on the Remote for 30 days; turning it on brings it back at once.')],
  // The copy here stays until it is freed from the card (where Forge was).
  act: (who, typed, code, proven) => account.turnOff(repo, who, typed, code, proven),
});

/** A passkey used this long ago still counts as just now: the Remote takes one for five minutes (service/app.ts `proven`). */
const PROOF = 4 * 60 * 1000;

/**
 * In the card: the names and the code, then a passkey; then the deed, on the
 * side it was pressed (`from`: the switch at the right, 廃棄 at the left), so
 * each step on to it comes under the pointer, and Not now on the other. With
 * no code yet, the card sets it first (making a passkey if the account has
 * none, then confirming with it) and goes straight on to the names.
 */
async function confirm(el: HTMLElement, from: Element, repo: string, ask: Ask, done: () => Promise<void>, keyed: () => void) {
  const answers = askFoot(from, el);
  // The card keeps its size while it asks, so the answers come where its own deeds were.
  el.style.minHeight = `${el.offsetHeight}px`;
  const cancel = button(t('Not now'), 'small-button');
  // The card drawn again, the keyboard goes back to its switch rather than to the page.
  const back = () => { if (document.activeElement === document.body) document.querySelector<HTMLElement>(`.card[data-repo="${CSS.escape(repo)}"] .power`)?.focus(); };
  cancel.addEventListener('click', () => void done().then(back));
  const field = (label: string, attrs: Record<string, string> = {}) => h('input', {class: 'line-in', 'aria-label': label, placeholder: label, autocomplete: 'off', spellcheck: 'false', ...attrs}) as HTMLInputElement;
  // A deed that comes under the pointer holds still a moment, so a double click does not answer it.
  const settled = (b: HTMLButtonElement, error: HTMLElement, f: () => Promise<void>) => {
    const shown = performance.now();
    b.addEventListener('click', () => { if (performance.now() - shown >= SETTLE) void pressing(b, error, f); });
  };
  // The name checked is the account's, as its provider gave it; no page shows it, so the ask says it.
  const [code, me] = await Promise.all([account.offCode().catch(() => ({set: false})), account.me().catch(() => null)]);
  let provenAt = 0;
  const names = () => {
    const error = h('p', {class: 'error', role: 'alert'});
    const who = field(t('Your name'));
    const which = field(t('The repo\'s name'));
    const five = field(t('Code'), {maxlength: '5', class: 'line-in mono'});
    // 廃棄 is asked for as it was pressed, ink when the pointer is on it.
    const go = button(ask.verb, from.classList.contains('discard') ? 'small-button discard' : 'small-button primary');
    settled(go, error, async () => {
      await ask.act(who.value, which.value, five.value, Date.now() - provenAt < PROOF);
      await look();
      await done();
      back();
    });
    el.replaceChildren(h('div', {class: 'off-ask', role: 'group', 'aria-label': repo}, h('span', {class: 'card-title'}, repo),
      ...ask.what.map((line) => h('p', {class: 'muted small'}, line)),
      me?.name ? h('p', {class: 'muted small'}, t('To confirm, type {name}, {repo} and your code.', {name: me.name, repo})) : null,
      who, which, five, error, answers(cancel, go)));
    who.focus();
  };
  if (code.set) { names(); return; }
  // No code yet: it is set here, then the names are asked at once.
  const keys = await account.passkeys().catch(() => null);
  let none = !!keys && !keys.length;
  const error = h('p', {class: 'error', role: 'alert'});
  const five = field(t('New code'), {maxlength: '5', class: 'line-in mono'});
  const go = button(t('Set the code'), 'small-button primary');
  settled(go, error, async () => {
    if (!/^[A-Za-z0-9]{5}$/.test(five.value)) throw new Error(t('Five letters or digits.'));
    // Made once: pressed again after the confirming step was stopped, the passkey made is the one used.
    if (none) { await account.addPasskey(); none = false; keyed(); }
    await account.setOffCode(five.value);
    keyed();
    provenAt = Date.now();
    names();
  });
  el.replaceChildren(h('div', {class: 'off-ask', role: 'group', 'aria-label': repo}, h('span', {class: 'card-title'}, repo),
    h('p', {class: 'muted small'}, t('This asks for a five-letter code of your own.')),
    h('p', {class: 'muted small'}, none ? t('Set it here, with a new passkey on this device.') : t('Set it here, with your passkey.')),
    five, error, answers(cancel, go)));
  five.focus();
}

/** No passkey yet: the button, which says it. */
function passkeyOffer(added: () => void): HTMLElement {
  const box = h('section', {class: 'offer-holder', hidden: ''});
  const error = h('p', {class: 'error', role: 'alert'});
  void account.passkeys().then((list) => {
    if (list.length) return;
    const add = button(t('Add a passkey'), 'small-button primary');
    add.addEventListener('click', () => void pressing(add, error, async () => { await account.addPasskey(); box.hidden = true; added(); }));
    box.hidden = false;
    // An offer goes on: at the right, as every deed that goes on is.
    box.replaceChildren(answers(null, add), error);
  }, () => {});
  return box;
}

/** The code turning a repo off asks for: five letters or digits, set with a passkey. */
function codeSection(): HTMLElement {
  const section = h('section', {class: 'sub-part', 'aria-labelledby': 'remote-code'});
  const error = h('p', {class: 'error', role: 'alert'});
  const paint = async () => {
    const now = await account.offCode().catch(() => ({set: false, setAt: null}));
    const five = h('input', {class: 'line-in mono code-in', maxlength: '5', placeholder: t('New code'), 'aria-label': t('Code'), autocomplete: 'off', spellcheck: 'false'}) as HTMLInputElement;
    const set = button(now.set ? t('Set another') : t('Set'), 'small-button');
    set.addEventListener('click', () => void pressing(set, error, async () => {
      if (!/^[A-Za-z0-9]{5}$/.test(five.value)) throw new Error(t('Five letters or digits.'));
      await account.setOffCode(five.value);
      await paint();
    }));
    section.replaceChildren(h('h3', {id: 'remote-code'}, h('span', {}, t('Code to turn a repo off'))),
      h('div', {class: 'rows'}, h('div', {class: 'row-item usage-prompt'},
        h('span', {class: 'row-name'}, now.set ? t('Set {when}', {when: ago(now.setAt ?? 0)}) : t('Not set')), five, set)), error);
  };
  void paint();
  return section;
}

function passkeySection(): HTMLElement {
  const section = h('section', {class: 'sub-part', 'aria-labelledby': 'remote-keys'});
  const error = h('p', {class: 'error', role: 'alert'});
  const paint = async () => {
    const list = await account.passkeys().catch((e) => { error.textContent = message(e); return []; });
    const add = button(t('Add a passkey'), 'small-button');
    add.addEventListener('click', () => void pressing(add, error, async () => { await account.addPasskey(); await paint(); }));
    section.replaceChildren(h('h3', {id: 'remote-keys'}, h('span', {}, t('Passkeys'), list.length ? h('small', {}, `${list.length}`) : null), add),
      h('div', {class: 'rows'}, ...(list.length ? list.map((k) => {
        const remove = button(t('Remove'), 'small-button');
        remove.addEventListener('click', () => void pressing(remove, error, async () => { await account.removePasskey(k.id); await paint(); }));
        return h('div', {class: 'row-item usage-prompt'}, h('span', {class: 'row-name'}, k.name || t('Passkey')),
          h('span', {class: 'row-meta'}, `${t('Made {when}', {when: ago(Date.parse(k.createdAt))})}${k.backedUp ? ` · ${t('synced passkey')}` : ''}`), remove);
      }) : [h('div', {class: 'row-item muted'}, t('No passkeys yet'))])), error);
  };
  void paint();
  return section;
}

/** The providers this account signs in with: each is also the way back in. */
function providerSection(): HTMLElement {
  const section = h('section', {class: 'sub-part', 'aria-labelledby': 'remote-providers'});
  const error = h('p', {class: 'error', role: 'alert'});
  const paint = async () => {
    let mine: Awaited<ReturnType<typeof account.linked>>, offered: Awaited<ReturnType<typeof account.about>>;
    try { [mine, offered] = await Promise.all([account.linked(), account.about()]); } catch (e) { error.textContent = message(e); return; }
    const have = new Set(mine.map((a) => a.providerId));
    const rows = mine.map((a) => {
      // The last provider is the way back in: it stays, with nothing to press.
      const off = mine.length > 1 ? button(t('Unlink'), 'small-button') : null;
      off?.addEventListener('click', () => void pressing(off, error, async () => { await account.unlink(a.providerId); await paint(); }));
      return h('div', {class: 'row-item usage-prompt'},
        h('span', {class: 'row-name'}, account.PROVIDER_NAME[a.providerId as account.Provider] ?? a.providerId),
        h('span', {class: 'row-meta'}, t('Linked {when}', {when: ago(Date.parse(a.createdAt))})), off);
    });
    const more = offered.providers.filter((p) => !have.has(p)).map((p) => {
      const b = button(t('Link {name}', {name: account.PROVIDER_NAME[p]}), 'small-button');
      b.addEventListener('click', () => void pressing(b, error, () => account.link(p)));
      return b;
    });
    section.replaceChildren(h('h3', {id: 'remote-providers'}, h('span', {}, t('Sign-in providers'))), h('div', {class: 'rows'}, ...rows),
      ...(more.length ? [h('div', {class: 'row work-act'}, ...more)] : []), error);
  };
  void paint();
  return section;
}

/**
 * The devices signed in: each and when it was last used, this one marked.
 * Any other is signed out from its row (the same Remote call as `l3 remote
 * devices rm N`), asked in the row first, Sign out where it was pressed and
 * Not now at the left; this one signs out from the person's menu.
 */
function deviceSection(counted: (n: number) => void): HTMLElement {
  const section = h('div', {class: 'sub-part'});
  const error = h('p', {class: 'error', role: 'alert'});
  const paint = async () => {
    const list = await account.devices().catch((e) => { error.textContent = message(e); return []; });
    counted(list.length);
    section.replaceChildren(h('div', {class: 'rows'}, ...list.map((d) => deviceRow(d, paint))), error);
  };
  void paint();
  return section;
}

function deviceRow(d: account.Device, again: () => Promise<void>): HTMLElement {
  const name = account.deviceWord(d.userAgent);
  const out = d.current ? null : button(t('Sign out'), 'small-button');
  out?.setAttribute('aria-label', t('Sign out {name}', {name}));
  // Which one it is: its word and when it was last used (two browsers of a kind read the same).
  const head = () => [h('span', {class: 'row-name'}, name), d.current ? h('span', {class: 'row-meta'}, t('This device')) : null,
    h('span', {class: 'row-meta'}, t('Used {when}', {when: ago(Date.parse(d.updatedAt))}))];
  const row = h('div', {class: 'row-item usage-prompt'}, ...head(), out);
  out?.addEventListener('click', () => {
    const foot = askFoot(out, row);
    const error = h('p', {class: 'error small', role: 'alert'});
    const no = button(t('Not now'), 'small-button'), yes = button(t('Sign out'), 'small-button primary');
    const ask = h('div', {class: 'row-ask', role: 'group', 'aria-label': t('Sign out {name}', {name})},
      h('div', {class: 'row-item'}, ...head()),
      h('p', {class: 'muted small'}, t('It is signed out at once.')),
      h('p', {class: 'muted small'}, t('What is on it stays there; signing in again brings it back.')), error, foot(no, yes));
    no.addEventListener('click', () => { ask.replaceWith(row); out.focus(); });
    const shown = performance.now();
    yes.addEventListener('click', () => {
      if (performance.now() - shown < SETTLE) return;
      void pressing(yes, error, async () => { await account.endDevice(d); await again(); });
    });
    row.replaceWith(ask);
    yes.focus();
  });
  return row;
}

/**
 * Plan: what this account has (Free or Paid, and when it renews or ends), its
 * use of what the Remote keeps against the free allowance, what paid adds, and
 * one deed at the right of its foot: Subscribe (Checkout) or Manage the plan
 * (the portal). The Remote decides all of it (service/plan.ts); this shows it.
 * `offered` says whether this Remote has a plan at all.
 */
function planSection(offered: (on: boolean) => void): {el: HTMLElement; paint(): Promise<void>} {
  const el = h('div', {class: 'plan-part'});
  const error = h('p', {class: 'error', role: 'alert'});
  const paint = async () => {
    let p: Awaited<ReturnType<typeof readPlan>>;
    try { p = await readPlan(); } catch (e) { error.textContent = message(e); return; }
    offered(p.plan !== 'none');
    if (p.plan === 'none') { el.replaceChildren(); return; }
    const v = planView(p);
    error.textContent = '';
    const go = v.action ? button(v.action.label, 'primary') : null;
    if (go && v.action) {
      const kind = v.action.kind;
      go.addEventListener('click', () => void pressing(go, error, () => openPlan(kind)));
    }
    el.replaceChildren(
      h('section', {class: 'sub-part plan-now', 'aria-labelledby': 'plan-title'},
        h('h2', {id: 'plan-title', class: 'plan-title'}, v.title), h('p', {class: 'muted'}, v.line)),
      h('section', {class: 'sub-part', 'aria-labelledby': 'plan-use'}, h('h3', {id: 'plan-use'}, h('span', {}, t('On the Remote'))),
        h('div', {class: 'rows'}, ...v.meters.map((m) => h('div', {class: `row-item plan-meter${m.over ? ' over' : ''}`},
          h('span', {class: 'row-name'}, m.label),
          m.of === null ? null : h('span', {class: 'meter', role: 'meter', 'aria-label': m.label, 'aria-valuemin': '0', 'aria-valuemax': '100',
            'aria-valuenow': String(Math.round(m.share * 100)), style: `--share: ${m.share}`}, h('span', {})),
          h('span', {class: 'row-meta'}, m.of === null ? m.used : t('{used} of {of}', {used: m.used, of: m.of}))))),
        v.note ? h('p', {class: 'muted small plan-note'}, v.note) : null),
      h('section', {class: 'sub-part', 'aria-labelledby': 'plan-adds'}, h('h3', {id: 'plan-adds'}, h('span', {}, p.plan === 'paid' ? t('Paid gives') : t('Paid adds'))),
        h('div', {class: 'rows plan-adds'}, ...v.adds.map((a) => h('div', {class: 'row-item'}, h('span', {class: 'row-name'}, a))))),
      ...(go ? [answers(null, go)] : []), error);
  };
  return {el, paint};
}

/** One line while the Remote does not answer; gone once it does. */
function awayLine(): HTMLElement {
  const line = h('p', {class: 'muted away-line', role: 'status'}, t('The Remote cannot be reached. What changes here is sent once it can.'));
  const show = () => { line.hidden = !account.remoteAway(); };
  show();
  const stop = account.onReach(() => { if (!line.isConnected) { stop(); return; } show(); });
  return line;
}

export function remote(ctx: Context): Node[] {
  const holder = h('div', {});
  let shown: string | null = null;
  const paint = () => {
    const c = account.connection();
    const now = c ? 'in' : '';
    if (now === shown) return;
    shown = now;
    if (!c) {
      holder.replaceChildren(signInPlace(t('Sign in'), signInBox(() => paint())));
      return;
    }
    // One part at a time: the repos it keeps, how this account signs in, the devices in it.
    const page = parts<'repos' | 'sign-in' | 'devices' | 'plan'>('remote', [
      {id: 'repos', label: t('Repos')}, {id: 'sign-in', label: t('Sign-in')}, {id: 'devices', label: t('Devices')}, {id: 'plan', label: t('Plan')}]);
    // The plan is the Remote's to say: shown once it says there is one, read again whenever its part is shown
    // or the window comes back (from Checkout or the portal, in another tab or the browser).
    const plan = planSection((on) => page.offer('plan', on));
    page.panel('plan').append(plan.el);
    void plan.paint();
    page.onShow((k) => { if (k === 'plan') void plan.paint(); });
    const back = () => { if (!holder.isConnected) { document.removeEventListener('visibilitychange', back); return; } if (!document.hidden) void plan.paint(); };
    document.addEventListener('visibilitychange', back);
    // Under the repos (it is what lets one be turned off); a passkey added from it shows under Sign-in at once.
    const offer = isNative ? null : passkeyOffer(() => { shown = null; paint(); });
    // A Remote entered by its link has no passkeys or providers to manage: only the code a repo is turned off with.
    const signIn = () => {
      if (isNative) page.panel('sign-in').replaceChildren(h('p', {class: 'muted'}, t('Passkeys and providers are managed in the browser.')));
      else void account.about().then(({enter}) => page.panel('sign-in').replaceChildren(...(enter
        ? [h('p', {class: 'muted'}, t('You came in by the link you were given; each time lasts a day.')), codeSection()]
        : [passkeySection(), codeSection(), providerSection()])));
    };
    signIn();
    // The code (and a passkey) set while a repo is turned off: the offer has done its work, and Sign-in reads them again when shown.
    let stale = false;
    page.onShow((k) => { if (k === 'sign-in' && stale) { stale = false; signIn(); } });
    page.panel('repos').append(repoSection(ctx, (n) => page.count('repos', n), () => { stale = true; if (offer) offer.hidden = true; }, () => page.show('plan')));
    page.panel('devices').append(deviceSection((n) => page.count('devices', n)));
    holder.replaceChildren(
      h('div', {class: 'part-bar'}, page.switch),
      awayLine(),
      page.panel('repos'), page.panel('sign-in'), page.panel('devices'), page.panel('plan'));
    // The passkey offer belongs to the repos it lets be turned off: under them, never under another part.
    if (offer) page.panel('repos').append(offer);
  };
  paint();
  const stop = account.onConnection(() => { if (!holder.isConnected) { stop(); return; } paint(); });
  return [pageHead('remote'), holder];
}
