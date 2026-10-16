import {ago, bytes, h} from '../dom.ts';
import {isNative} from '../host.ts';
import {t, tn} from '../i18n.ts';
import {bring, onSync, remoteOnly, repoState, type RepoSync} from '../lifecycle.ts';
import * as account from '../remote.ts';
import {store} from '../repos.ts';
import {pageHead, parts} from './common.ts';
import type {Context} from './context.ts';

// Remote: where the canonical copy is, and who this device is there.
//
// Not signed in: one sentence on what it means, and the ways in. A browser
// signs in with GitHub or Google, or with a passkey it already has; the app
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
export function signInBox(done: () => void, words?: string, back?: string): HTMLElement {
  const error = h('p', {class: 'error', role: 'alert'});
  const box = h('div', {class: 'remote-join'}, h('p', {class: 'muted'}, words ?? (isNative
    ? t('The canonical copy is kept on the Remote. Once this device is connected, what you change is sent at once, and your other devices can open it.')
    : t('The canonical copy is kept on the Remote. Once you are signed in, what you change is sent at once; closing this tab lets go of this browser\'s copy.'))));
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
    box.append(h('div', {class: 'row'}, go), waiting, error);
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
  box.append(providers, h('div', {class: 'row'}, passkey),
    h('p', {class: 'muted small'}, t('Lost every passkey? Sign in with GitHub or Google again and add a new one.')), error);
  return box;
}

function repoSection(ctx: Context, counted: (n: number) => void): HTMLElement {
  const rows = h('div', {class: 'rows'});
  const error = h('p', {class: 'error', role: 'alert'});
  const section = h('div', {class: 'sub-part'}, rows, error);
  const paint = async () => {
    const here = await store.list().catch(() => []);
    const items: Node[] = here.map((r) => {
      const s = repoState(r.name);
      const row = h('button', {type: 'button', class: 'row-item', 'data-where': s?.where ?? ''},
        h('span', {class: 'row-name'}, r.name), h('span', {class: 'row-meta'}, syncWord(s)));
      if (s?.error) row.title = s.error;
      row.addEventListener('click', () => ctx.openRepo(r.name));
      return row;
    });
    for (const r of remoteOnly()) {
      const open = button(t('Open'), 'small-button');
      open.addEventListener('click', () => void pressing(open, error, async () => { await bring(r.name); ctx.openRepo(r.name); }));
      items.push(h('div', {class: 'row-item usage-prompt'}, h('span', {class: 'row-name'}, r.name),
        h('span', {class: 'row-meta'}, t('Only on the Remote · {size}', {size: bytes(r.bytes)})), open));
    }
    counted(items.length);
    rows.replaceChildren(...(items.length ? items : [h('div', {class: 'row-item muted'}, t('No repos yet'))]));
  };
  void paint();
  const stop = onSync(() => { if (!section.isConnected) { stop(); return; } void paint(); });
  return section;
}

/** No passkey yet: one line and the button, above everything else. */
function passkeyOffer(): HTMLElement {
  const box = h('section', {class: 'section offer', hidden: ''});
  const error = h('p', {class: 'error', role: 'alert'});
  void account.passkeys().then((list) => {
    if (list.length) return;
    const add = button(t('Add a passkey'), 'primary');
    add.addEventListener('click', () => void pressing(add, error, async () => { await account.addPasskey(); box.hidden = true; }));
    box.hidden = false;
    box.replaceChildren(h('div', {class: 'row reclaim-act'},
      h('span', {class: 'grow'}, t('Add a passkey for this device, so next time you sign in without GitHub or Google.')), add), error);
  }, () => {});
  return box;
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
    const now = c ? c.token : '';
    if (now === shown) return;
    shown = now;
    if (!c) {
      holder.replaceChildren(h('section', {class: 'section'}, signInBox(() => paint())));
      return;
    }
    // One part at a time: the repos it keeps, how this account signs in, the devices in it.
    const page = parts<'repos' | 'sign-in' | 'devices'>('remote', [
      {id: 'repos', label: t('Repos')}, {id: 'sign-in', label: t('Sign-in')}, {id: 'devices', label: t('Devices')}]);
    page.panel('repos').append(repoSection(ctx, (n) => page.count('repos', n)));
    page.panel('sign-in').append(...(isNative
      ? [h('p', {class: 'muted'}, t('Passkeys and providers are managed in the browser.'))]
      : [passkeySection(), providerSection()]));
    page.panel('devices').append(deviceSection((n) => page.count('devices', n)));
    holder.replaceChildren(
      ...(isNative ? [] : [passkeyOffer()]),
      h('div', {class: 'part-bar'}, page.switch),
      page.panel('repos'), page.panel('sign-in'), page.panel('devices'));
  };
  paint();
  const stop = account.onConnection(() => { if (!holder.isConnected) { stop(); return; } paint(); });
  return [pageHead('remote'), holder];
}
