import {ago, bytes, h} from '../dom.ts';
import {isNative} from '../host.ts';
import {t, tn} from '../i18n.ts';
import {bring, look, onSync, remoteAll, repoState, type RepoSync} from '../lifecycle.ts';
import * as draft from '../draft.ts';
import type {RemoteRepo} from '../draft.ts';
import * as account from '../remote.ts';
import {kept, store} from '../repos.ts';
import * as servers from '../servers.ts';
import {pageHead, parts} from './common.ts';
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

export function signInBox(done: () => void, words?: string, back?: string): HTMLElement {
  const error = h('p', {class: 'error', role: 'alert'});
  const box = h('div', {class: 'remote-join'}, h('p', {class: 'muted'}, words ?? (isNative
    ? t('Connect this device, and the Remote keeps your repos: each change goes there by itself, and your other devices have it too.')
    : t('Sign in, and the Remote keeps your repos: each change goes there by itself, so this browser keeps nothing once the tab is closed.'))));
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
  void account.about().then(({providers: list}) => {
    providers.replaceChildren(...list.map((p, i) => {
      const b = button(t('Continue with {name}', {name: account.PROVIDER_NAME[p]}), i === 0 ? 'primary' : '');
      b.addEventListener('click', () => void pressing(b, error, () => account.signInWith(p, back)));
      return b;
    }));
    if (!list.length) providers.replaceChildren(h('span', {class: 'muted'}, t('This Remote offers no way to sign in yet.')));
  });
  const passkey = button(t('Sign in with a passkey'));
  passkey.addEventListener('click', () => void pressing(passkey, error, async () => { await account.signIn(); done(); }));
  box.append(providers, h('div', {class: 'row sign-in-row'}, passkey),
    h('p', {class: 'muted small'}, t('Lost your passkeys? Continue with one of the above, then add a new one.')), error);
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
  const paint = async () => {
    const here = await store.list().catch(() => []);
    const there = remoteAll();
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
    const forge = button(t('Forge'), 'small-button');
    forge.disabled = off;
    forge.addEventListener('click', () => void pressing(forge, error, async () => { if (!here) await bring(name); ctx.openRepo(name); }));
    const power = h('button', {type: 'button', class: 'power', role: 'switch', 'aria-checked': String(!off),
      'aria-label': off ? t('Turn {repo} on', {repo: name}) : t('Turn {repo} off', {repo: name})}, h('span', {class: 'knob'})) as HTMLButtonElement;
    const where = off
      ? t('Off · back until {date}', {date: new Date(there!.until!).toLocaleDateString()})
      : here ? syncWord(repoState(name)) : t('On the Remote');
    const who = seen.find((x) => x.name === name);
    const sees = who && !off ? button(seenWord(who), 'small-button seen-button') : null;
    const el = h('div', {class: `card repo${off ? ' off' : ''}`, 'data-repo': name},
      h('span', {class: 'card-title'}, name),
      h('span', {class: 'muted'}, `${bytes(size)} · ${t('Changed {when}', {when: ago(changed)})}`),
      h('span', {class: 'muted card-sync'}, where),
      h('div', {class: 'card-foot'}, forge, sees, h('span', {class: 'grow'}), power), error);
    sees?.addEventListener('click', () => void whoSees(el, who!, paint));
    power.addEventListener('click', () => {
      if (off) { void pressing(power, error, async () => { await account.turnOn(name); await look(); await paint(); }); return; }
      if (isNative) { error.textContent = t('A repo is turned off from the browser, where its passkey is.'); return; }
      void confirm(el, name, paint, toCode);
    });
    return el;
  };
  void look().then(paint);
  const stop = onSync(() => { if (!section.isConnected) { stop(); return; } if (!section.querySelector('.off-ask')) void paint(); });
  return section;
}

/** Who sees a repo, in a word or two. */
function seenWord(s: servers.RepoSeen): string {
  if (s.seen === 'everyone') return t('Everyone');
  if (s.seen === 'servers') return s.servers.length === 1 ? t('In {server}', {server: s.servers[0].name}) : t('In {n} servers', {n: s.servers.length});
  return t('Only you');
}

/**
 * In the card: who sees it. Only you; the servers it is shown in (only seen
 * there, as it was last pushed); or everyone, as a server's (by default the
 * one it goes public from, so nothing ties it to you) or as your own.
 */
async function whoSees(el: HTMLElement, now: servers.RepoSeen, done: () => Promise<void>) {
  const error = h('p', {class: 'error', role: 'alert'});
  const mine = await servers.servers().catch(() => [] as servers.Server[]);
  const me = await import('../inbox.ts').then((inbox) => inbox.me()).catch(() => null);
  let to = now.seen;
  const chosen = new Set(now.servers.map((s) => s.id));
  const chips = h('div', {class: 'chips', role: 'radiogroup', 'aria-label': t('Who sees it')});
  const body = h('div', {class: 'seen-choice'});
  // Seen by everyone as: a server it is in, else the first it is shown in, else yours.
  let as = now.asServer ?? now.servers[0]?.id ?? 'me';
  const paint = () => {
    chips.replaceChildren(...(['private', 'servers', 'everyone'] as const).map((v) => {
      const c = h('button', {type: 'button', class: 'chip', role: 'radio', 'aria-checked': String(v === to)},
        v === 'private' ? t('Only you') : v === 'servers' ? t('Servers') : t('Everyone'));
      c.addEventListener('click', () => { to = v; paint(); });
      return c;
    }));
    if (to === 'private') { body.replaceChildren(h('p', {class: 'muted small'}, t('Only you see it. It comes off every server too.'))); return; }
    if (to === 'servers') {
      body.replaceChildren(...(mine.length ? mine.map((s) => {
        const box = h('input', {type: 'checkbox'}) as HTMLInputElement;
        box.checked = chosen.has(s.id);
        box.addEventListener('change', () => { if (box.checked) chosen.add(s.id); else chosen.delete(s.id); });
        return h('label', {class: 'check-row'}, box, h('span', {}, s.name), h('span', {class: 'muted small mono'}, s.address));
      }) : [h('p', {class: 'muted small'}, t('You are in no server yet.'))]),
      h('p', {class: 'muted small'}, t('Their people see it as it was last pushed, and whose it is. Nobody writes in it but you.')));
      return;
    }
    const pick = h('select', {class: 'line-in', 'aria-label': t('Seen as')}) as HTMLSelectElement;
    const mineName = me?.addresses[0]?.address;
    pick.replaceChildren(...mine.filter((s) => s.address).map((s) => h('option', {value: s.id}, `${s.address}:${now.name}`)),
      ...(mineName ? [h('option', {value: 'me'}, `${mineName}:${now.name}`)] : []));
    pick.value = as;
    if (pick.selectedIndex < 0) pick.selectedIndex = 0;
    as = pick.value;
    const note = h('p', {class: 'muted small'});
    const say = () => { note.textContent = as === 'me' ? t('Anyone sees it under your name.') : t('Anyone sees it as the server\'s, without your name.'); };
    say();
    pick.addEventListener('change', () => { as = pick.value; say(); });
    body.replaceChildren(h('label', {class: 'check-row'}, h('span', {class: 'muted small'}, t('Seen as')), pick), note);
  };
  paint();
  const cancel = button(t('Not now'), 'small-button');
  cancel.addEventListener('click', () => void done());
  const save = button(t('Save'), 'small-button primary');
  save.addEventListener('click', () => void pressing(save, error, async () => {
    if (to === 'servers') await servers.setSeen(now.name, 'servers', {servers: [...chosen]});
    else if (to === 'everyone') await servers.setSeen(now.name, 'everyone', {as});
    else await servers.setSeen(now.name, 'private');
    await done();
  }));
  el.replaceChildren(h('div', {class: 'off-ask'}, h('span', {class: 'card-title'}, now.name), chips, body, error,
    h('div', {class: 'card-foot'}, cancel, h('span', {class: 'grow'}), save)));
}

/** In the card: the names and the code, then a passkey; the switch goes right and red. */
async function confirm(el: HTMLElement, repo: string, done: () => Promise<void>, toCode: () => void) {
  const error = h('p', {class: 'error', role: 'alert'});
  const cancel = button(t('Not now'), 'small-button');
  cancel.addEventListener('click', () => void done());
  const code = await account.offCode().catch(() => ({set: false}));
  if (!code.set) {
    const go = button(t('Set the code'), 'small-button primary');
    go.addEventListener('click', () => toCode());
    el.replaceChildren(h('div', {class: 'off-ask'}, h('span', {class: 'card-title'}, repo),
      h('p', {class: 'muted small'}, t('Turning a repo off asks for your five-letter code. Set it under Sign-in first.')),
      h('div', {class: 'card-foot'}, cancel, h('span', {class: 'grow'}), go)));
    return;
  }
  const field = (label: string, attrs: Record<string, string> = {}) => h('input', {class: 'line-in', 'aria-label': label, placeholder: label, autocomplete: 'off', spellcheck: 'false', ...attrs}) as HTMLInputElement;
  const who = field(t('Your name'));
  const which = field(t('The repo\'s name'));
  const five = field(t('Code'), {maxlength: '5', class: 'line-in mono'});
  const go = button(t('Turn off'), 'small-button primary');
  go.addEventListener('click', () => void pressing(go, error, async () => {
    await account.turnOff(repo, who.value, which.value, five.value);
    // The copy here goes with it; it comes back from the Remote when turned on and opened.
    if (!isNative) { await kept?.letGo([repo]); await draft.forget(repo); }
    await look();
    await done();
  }));
  el.replaceChildren(h('div', {class: 'off-ask'}, h('span', {class: 'card-title'}, repo),
    h('p', {class: 'muted small'}, t('Kept on the Remote for 30 days; turning it on brings it back at once.')),
    who, which, five, error,
    h('div', {class: 'card-foot'}, cancel, h('span', {class: 'grow'}), go)));
  who.focus();
}

/** No passkey yet: a short line and the button. */
function passkeyOffer(added: () => void): HTMLElement {
  const box = h('section', {class: 'offer-holder', hidden: ''});
  const error = h('p', {class: 'error', role: 'alert'});
  void account.passkeys().then((list) => {
    if (list.length) return;
    const add = button(t('Add a passkey'), 'small-button primary');
    add.addEventListener('click', () => void pressing(add, error, async () => { await account.addPasskey(); box.hidden = true; added(); }));
    box.hidden = false;
    box.replaceChildren(h('div', {class: 'offer'}, h('span', {}, t('Sign in faster with a passkey')), add), error);
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
      }) : [h('div', {class: 'row-item muted'}, t('No passkeys. With one, you sign in from any device without a provider.'))])), error);
  };
  void paint();
  return section;
}

/** The providers this account signs in with: each is also the way back in. */
function providerSection(): HTMLElement {
  const section = h('section', {class: 'sub-part', 'aria-labelledby': 'remote-providers'});
  const error = h('p', {class: 'error', role: 'alert'});
  const paint = async () => {
    const [mine, offered] = await Promise.all([account.linked().catch(() => []), account.about()]);
    const have = new Set(mine.map((a) => a.providerId));
    const rows = mine.map((a) => {
      const off = button(t('Unlink'), 'small-button');
      // The last provider is the way back in: it stays.
      off.disabled = mine.length < 2;
      if (off.disabled) off.title = t('The last way to sign in stays');
      off.addEventListener('click', () => void pressing(off, error, async () => { await account.unlink(a.providerId); await paint(); }));
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

function deviceSection(counted: (n: number) => void): HTMLElement {
  const section = h('div', {class: 'sub-part'});
  const error = h('p', {class: 'error', role: 'alert'});
  const paint = async () => {
    const list = await account.devices().catch((e) => { error.textContent = message(e); return []; });
    counted(list.length);
    section.replaceChildren(
      h('div', {class: 'rows'}, ...list.map((d) => {
        const act: Node = d.current ? (() => {
          const leave = button(t('Sign out'), 'small-button');
          leave.title = t('Sign out on this device');
          leave.addEventListener('click', () => void account.signOut());
          return h('span', {class: 'device-here'}, h('span', {class: 'row-meta'}, t('This device')), leave);
        })() : (() => {
          const end = button(t('Remove'), 'small-button');
          end.addEventListener('click', () => void pressing(end, error, async () => { await account.endDevice(d.token); await paint(); }));
          return end;
        })();
        return h('div', {class: 'row-item usage-prompt'}, h('span', {class: 'row-name'}, account.deviceWord(d.userAgent)),
          h('span', {class: 'row-meta'}, t('Used {when}', {when: ago(Date.parse(d.updatedAt))})), act);
      })), error);
  };
  void paint();
  return section;
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
      // A passkey added from the offer shows under Sign-in at once.
      ...(isNative ? [] : [passkeyOffer(() => { shown = null; paint(); })]),
      h('div', {class: 'part-bar'}, page.switch),
      page.panel('repos'), page.panel('sign-in'), page.panel('devices'));
  };
  paint();
  const stop = account.onConnection(() => { if (!holder.isConnected) { stop(); return; } paint(); });
  return [pageHead('remote'), holder];
}
