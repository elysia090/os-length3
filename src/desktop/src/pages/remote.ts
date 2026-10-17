import {ago, bytes, day, h} from '../dom.ts';
import {isNative} from '../host.ts';
import {t, tn} from '../i18n.ts';
import {bring, look, onSync, remoteAll, repoState, type RepoSync} from '../lifecycle.ts';
import type {RemoteRepo} from '../draft.ts';
import * as account from '../remote.ts';
import {store} from '../repos.ts';
import {freeOff} from '../space.ts';
import * as servers from '../servers.ts';
import {answers, askFoot, pageHead, parts} from './common.ts';
import type {Context} from './context.ts';

// Remote: where the canonical copy is, and who this device is there.
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
  if (s.where === 'sending') return t('Sending');
  if (s.where === 'offline') return s.changed ? tn('Not sent yet ({n} change)', 'Not sent yet ({n} changes)', s.changed) : t('Not sent yet');
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
    const go = button(t('Connect in the browser'), 'primary');
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
  const ways = () => void account.about().then(({providers: list}) => {
    providers.replaceChildren(...list.map((p, i) => {
      const b = button(t('Continue with {name}', {name: account.PROVIDER_NAME[p]}), i === 0 ? 'primary' : '');
      b.addEventListener('click', () => void pressing(b, error, () => account.signInWith(p, back)));
      return b;
    }));
    // No ways because it did not answer is not the same as none offered; the ways come once it answers.
    if (!list.length) providers.replaceChildren(h('span', {class: 'muted'}, account.remoteAway() ? t('The Remote cannot be reached') : t('This Remote offers no way to sign in yet.')));
  });
  ways();
  const stop = account.onReach(() => { if (!box.isConnected) { stop(); return; } if (!account.remoteAway()) ways(); });
  // Back from a provider without a session: why, once.
  error.textContent = account.takeSignInTrouble();
  const passkey = button(t('Sign in with a passkey'));
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
 * repo's name and the five-letter code; it is then kept 30 days, its switch
 * at the right and red, and pressing it again brings it back at once.
 */
function repoSection(ctx: Context, counted: (n: number) => void, toCode: () => void): HTMLElement {
  const grid = h('div', {class: 'grid repo-cards'});
  const section = h('div', {class: 'sub-part'}, grid);
  let seen: servers.RepoSeen[] = [];
  const paint = () => draw().catch((e) => grid.replaceChildren(h('p', {class: 'error'}, message(e))));
  const draw = async () => {
    const here = await store.list();
    const there = remoteAll();
    // Who sees each is the Remote's to say: away, no Share is offered (the rail and the line above say why).
    seen = account.connection() ? await servers.seenAll().catch(() => []) : [];
    const names = [...new Set([...here.map((r) => r.name), ...there.map((r) => r.name)])].sort();
    counted(names.length);
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
    const who = seen.find((x) => x.name === name);
    const share = who && !off ? sharing(who, error) : null;
    // Off, beside 空ける: 廃棄, which takes it from the Remote now, for good, asked for as turning it off was.
    const discard = off ? h('button', {type: 'button', class: 'button small-button discard'}, t('Discard')) as HTMLButtonElement : null;
    if (discard) discard.disabled = gone;
    const el = h('div', {class: `card repo${off ? ' off' : ''}`, 'data-repo': name},
      h('span', {class: 'card-title'}, name),
      h('span', {class: 'muted'}, `${bytes(size)} · ${t('Changed {when}', {when: ago(changed)})}`),
      h('span', {class: 'muted card-sync'}, where),
      // On the Remote's page the Remote's deeds are at the right: Share, then the switch. Forge leaves for
      // another page, at the left; the switch turned off makes it 空ける in the same place, 廃棄 beside it.
      h('div', {class: 'card-foot'}, forge, discard, h('span', {class: 'grow'}), share, power), error);
    power.addEventListener('click', () => {
      if (off) { void pressing(power, error, async () => { await account.turnOn(name); await look(); await paint(); }); return; }
      if (isNative) { error.textContent = t('A repo is turned off from the browser, where its passkey is.'); return; }
      void confirm(el, power, name, turningOff(name), paint, toCode);
    });
    discard?.addEventListener('click', () => {
      if (isNative) { error.textContent = t('A repo is discarded from the browser, where its passkey is.'); return; }
      void confirm(el, discard, name, {
        verb: t('Discard'),
        what: [t('It goes from the Remote now, with its history, and cannot be brought back.'), ...(here ? [t('The copy here goes with it.')] : [])],
        // The copy here first: one holding what the Remote lacks is kept, and nothing is discarded.
        act: async (who, typed, code) => { if (here) await freeOff(name); await account.discard(name, who, typed, code); },
      }, paint, toCode);
    });
    return el;
  };
  void look().then(paint);
  const again = () => { if (!section.isConnected) { stop(); unreach(); return; } if (!section.querySelector('.off-ask, .share-list:not([hidden])')) void paint(); };
  const stop = onSync(again);
  const unreach = account.onReach(again);
  return section;
}

/**
 * Share: pressed, the servers one is in come out beside it, each pressed in
 * where the repo is shown, and pressing one shows it there or takes it off
 * at once. Going public is the server's (its gear); it stays as it is here.
 */
function sharing(now: servers.RepoSeen, error: HTMLElement): HTMLElement {
  const open = button(t('Share'), 'small-button');
  open.setAttribute('aria-expanded', 'false');
  const list = h('span', {class: 'share-list', hidden: ''});
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
  open.addEventListener('click', async () => {
    const out = list.hidden;
    open.setAttribute('aria-expanded', String(out));
    list.hidden = !out;
    if (!out || (list.childElementCount && !('failed' in list.dataset))) return;
    let mine: servers.Server[];
    // Not read (away): said in the list, and read again the next time it opens.
    try { mine = await servers.servers(); } catch (e) { list.replaceChildren(h('span', {class: 'error small'}, message(e))); list.dataset.failed = ''; return; }
    delete list.dataset.failed;
    list.replaceChildren(...(mine.length ? mine.map((s) => {
      const c = h('button', {type: 'button', class: 'chip', 'aria-pressed': String(shared.has(s.id))}, s.name) as HTMLButtonElement;
      c.addEventListener('click', () => void pressing(c, error, async () => { await toggle(s.id); c.setAttribute('aria-pressed', String(shared.has(s.id))); }));
      return c;
    }) : [h('span', {class: 'muted small'}, t('In no server yet'))]));
  });
  // The servers come out to its left, into the space, so Share and the switch stay under the pointer.
  return h('span', {class: 'share'}, list, open);
}

/** What is asked for in the card before a repo is turned off or discarded: the deed's word, what will happen, and the deed. */
interface Ask { verb: string; what: string[]; act(name: string, typed: string, code: string): Promise<unknown> }
const turningOff = (repo: string): Ask => ({
  verb: t('Turn off'),
  what: [t('Kept on the Remote for 30 days; turning it on brings it back at once.')],
  // The copy here stays until it is freed from the card (where Forge was).
  act: (who, typed, code) => account.turnOff(repo, who, typed, code),
});

/**
 * In the card: the names and the code, then a passkey; then the deed, on the
 * side it was pressed (`from`: the switch at the right, 廃棄 at the left), so
 * each step on to it comes under the pointer, and Not now on the other.
 */
async function confirm(el: HTMLElement, from: Element, repo: string, ask: Ask, done: () => Promise<void>, toCode: () => void) {
  const answers = askFoot(from, el);
  const error = h('p', {class: 'error', role: 'alert'});
  const cancel = button(t('Not now'), 'small-button');
  cancel.addEventListener('click', () => void done());
  const foot = (go: HTMLElement) => answers(cancel, go);
  const code = await account.offCode().catch(() => ({set: false}));
  if (!code.set) {
    const go = button(t('Set the code'), 'small-button primary');
    go.addEventListener('click', () => toCode());
    el.replaceChildren(h('div', {class: 'off-ask'}, h('span', {class: 'card-title'}, repo),
      h('p', {class: 'muted small'}, t('Turning a repo off or discarding it asks for your five-letter code. Set it under Sign-in first.')),
      foot(go)));
    return;
  }
  const field = (label: string, attrs: Record<string, string> = {}) => h('input', {class: 'line-in', 'aria-label': label, placeholder: label, autocomplete: 'off', spellcheck: 'false', ...attrs}) as HTMLInputElement;
  const who = field(t('Your name'));
  const which = field(t('The repo\'s name'));
  const five = field(t('Code'), {maxlength: '5', class: 'line-in mono'});
  // 廃棄 is asked for as it was pressed, ink when the pointer is on it.
  const go = button(ask.verb, from.classList.contains('discard') ? 'small-button discard' : 'small-button primary');
  go.addEventListener('click', () => void pressing(go, error, async () => {
    await ask.act(who.value, which.value, five.value);
    await look();
    await done();
  }));
  el.replaceChildren(h('div', {class: 'off-ask'}, h('span', {class: 'card-title'}, repo),
    ...ask.what.map((line) => h('p', {class: 'muted small'}, line)),
    who, which, five, error, foot(go)));
  who.focus();
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

/** The devices signed in, as a history: each and when it was last used, this one marked. Signing out is at the foot of the rail. */
function deviceSection(counted: (n: number) => void): HTMLElement {
  const section = h('div', {class: 'sub-part'});
  const error = h('p', {class: 'error', role: 'alert'});
  const paint = async () => {
    const list = await account.devices().catch((e) => { error.textContent = message(e); return []; });
    counted(list.length);
    section.replaceChildren(
      h('div', {class: 'rows'}, ...list.map((d) => h('div', {class: 'row-item usage-prompt'}, h('span', {class: 'row-name'}, account.deviceWord(d.userAgent)),
        d.current ? h('span', {class: 'row-meta'}, t('This device')) : null,
        h('span', {class: 'row-meta'}, t('Used {when}', {when: ago(Date.parse(d.updatedAt))}))))), error);
  };
  void paint();
  return section;
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
    const page = parts<'repos' | 'sign-in' | 'devices'>('remote', [
      {id: 'repos', label: t('Repos')}, {id: 'sign-in', label: t('Sign-in')}, {id: 'devices', label: t('Devices')}]);
    page.panel('repos').append(repoSection(ctx, (n) => page.count('repos', n), () => page.show('sign-in')));
    page.panel('sign-in').append(...(isNative
      ? [h('p', {class: 'muted'}, t('Passkeys and providers are managed in the browser.'))]
      : [passkeySection(), codeSection(), providerSection()]));
    page.panel('devices').append(deviceSection((n) => page.count('devices', n)));
    holder.replaceChildren(
      h('div', {class: 'part-bar'}, page.switch),
      awayLine(),
      page.panel('repos'), page.panel('sign-in'), page.panel('devices'),
      // Under the parts, not over them; a passkey added from it shows under Sign-in at once.
      ...(isNative ? [] : [passkeyOffer(() => { shown = null; paint(); })]));
  };
  paint();
  const stop = account.onConnection(() => { if (!holder.isConnected) { stop(); return; } paint(); });
  return [pageHead('remote'), holder];
}
