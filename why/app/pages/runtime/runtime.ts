import {h} from '../../ui/dom.ts';
import {isNative, type Freed} from '../../../api/host.ts';
import {t} from '../../../text/i18n.ts';
import {onSync, remoteOnly, repoState} from '../../../shipto/lifecycle.ts';
import {connection} from '../../../shipto/connection.ts';
import {deviceStateKey} from './device-state.ts';
import {readSpace} from '../../../device/space.ts';
import {pageHead, parts} from '../kit/common.ts';
import {deskSearch, placesMenu} from '../kit/places.ts';
import type {Context} from '../kit/context.ts';
import {allSessions} from '../bench/sessions.ts';
import {errorText} from '../../../api/errors.ts';
import {device} from './device.ts';
import {prompts} from './prompts.ts';
import {environment} from './environment.ts';
import {desktopApp} from './desktop-app.ts';
import {sshSection} from './ssh.ts';
import {dotfilesSection} from './dotfiles.ts';
import {agentSection} from './agent-part.ts';

// Runtime: this device, then what the OS holds on it, then what is running,
// then the environment actually in effect (what runs, not what was asked for).
//
// In parts, as Remote's page is: this device (the bar and the box), the
// Prompts running (offered while one runs), the environments (SSH, the
// environment in effect and, on the web, the desktop app, side by side), and
// the dotfiles. Only the part chosen shows; the others are hidden, never
// stopped or emptied (a Prompt runs on, a dotfile half written stays).

/**
 * Runtime, in parts as Remote's page is: this device and what can go from it and come to it, the Prompts
 * running (offered while there is one), the environments, and the dotfiles. Hidden parts go on: a Prompt runs,
 * what is read is read again, a dotfile half written stays.
 */
export function runtime(ctx: Context): Node[] {
  const page = parts<'device' | 'prompts' | 'environments' | 'dotfiles' | 'agent'>('runtime', [
    {id: 'device', label: isNative ? t('This device') : t('This browser')}, {id: 'prompts', label: t('Running Prompts')},
    {id: 'environments', label: t('Environments')}, {id: 'dotfiles', label: t('Dotfiles')}, {id: 'agent', label: t('Agent')}], undefined, 'quiet');
  const holder = h('div', {}, h('section', {class: 'section'}, h('p', {class: 'muted'}, t('Calculating storage…'))));
  let last: Freed | null = null;
  let requestedFocus: string | undefined;
  let drawn = '', generation = 0;
  let waiting: ReturnType<typeof setTimeout> | undefined;
  const inHand = () => !!holder.querySelector(
    '.repo-gear-button[aria-expanded="true"], [aria-busy="true"], .storage-batch-ask');
  const read = (fresh = false): void => {
    const g = ++generation;
    clearTimeout(waiting);
    const defer = () => { waiting = setTimeout(() => { if (holder.isConnected) read(fresh); }, 350); };
    if (holder.isConnected && inHand()) { defer(); return; }
    void readSpace(allSessions().filter(([, s]) => s.running).map(([repo]) => repo), fresh).then((u) => {
      if (g !== generation) return;
      if (holder.isConnected && inHand()) { defer(); return; }
      const now = deviceStateKey(u, last, u.items.map((i) => i.id.startsWith('repo:') ? repoState(i.what) : undefined), remoteOnly(), !!connection());
      if (now !== drawn) {
        drawn = now;
        const at = document.activeElement;
        const onSheet = holder.contains(at);
        const requested = onSheet || at === document.body ? requestedFocus : undefined;
        const key = requested ?? (onSheet && at instanceof HTMLElement ? at.dataset.spaceFocus : undefined);
        requestedFocus = undefined;
        holder.replaceChildren(device(ctx, u, last, (r, focus) => { last = r; requestedFocus = focus; read(); }));
        if (key && holder.isConnected && !holder.closest('[hidden]')) {
          const find = (id: string) => holder.querySelector<HTMLElement>(`[data-space-focus="${CSS.escape(id)}"]`);
          (find(key) ?? find('here-col'))?.focus({preventScroll: !requested});
        }
      }
      if (u.kept && holder.isConnected) read(true);
    }, (e) => {
      if (g !== generation) return;
      if (holder.isConnected && inHand()) { defer(); return; }
      drawn = '';
      holder.replaceChildren(h('section', {class: 'section'}, h('p', {class: 'error'}, t('Storage calculation failed ({why})', {why: errorText(e)}))));
    });
  };
  read();
  // What the Remote holds changes what can come here.
  const stop = onSync(() => { if (!holder.isConnected) { stop(); return; } read(); });
  // Prompts started again from Dotfiles are new sessions: the section is drawn again to follow them. Its part is
  // offered while one runs (or one stopped here says what it gave back); a Prompt stopped or started reads again
  // what holds each repo, so its row says at once whether it can be freed.
  const heard = (n: number, any: boolean) => { page.count('prompts', n); page.offer('prompts', any); };
  const following = () => { if (holder.isConnected) read(); };
  let running = prompts(heard, following);
  const restarted = () => { const next = prompts(heard, following); running.replaceWith(next); running = next; };
  page.panel('device').append(holder);
  page.panel('prompts').append(running);
  // More about the same device, at the same reading edge; the inactive panels stay live.
  page.panel('environments').append(h('div', {class: 'runtime-leaf runtime-environments'},
    h('section', {class: 'section', 'aria-labelledby': 'env-title'}, h('h2', {id: 'env-title'}, t('Active environment')), environment()),
    isNative ? null : desktopApp(), sshSection()));
  page.panel('dotfiles').append(dotfilesSection(restarted, (n) => page.count('dotfiles', n)));
  // The Agent's key is local; dotfiles remain the person's on every device.
  page.panel('agent').append(agentSection());
  const head = pageHead('runtime', false);
  // Runtime keeps the page and its parts; navigation moves from the rail to the same Places as the work desks.
  placesMenu(head, ['Runtime'] as const, 'Runtime', () => {}, () => ctx.placeCommands?.(['runtime']) ?? [], {find: deskSearch(ctx)});
  return [head, h('div', {class: 'part-bar'}, page.switch),
    page.panel('device'), page.panel('prompts'), page.panel('environments'), page.panel('dotfiles'), page.panel('agent')];
}
