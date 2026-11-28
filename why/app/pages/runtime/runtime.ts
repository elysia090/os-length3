import {h} from '../../ui/dom.ts';
import {isNative, type Freed} from '../../../api/host.ts';
import {t} from '../../../text/i18n.ts';
import {onSync, remoteOnly, repoState} from '../../../shipto/lifecycle.ts';
import {connection} from '../../../shipto/connection.ts';
import {deviceStateKey} from './device-state.ts';
import {readSpace} from '../../../device/space.ts';
import {parts} from '../kit/common.ts';
import {deskSearch, placesMenu} from '../kit/places.ts';
import type {Context} from '../kit/context.ts';
import {purpose} from '../../host/purposes.ts';
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

// Only the current person's live reading position, never stored in settings or history.
let inventoryReading: {person: string | null; y: number} | undefined;
type RuntimePart = 'device' | 'prompts' | 'environments' | 'dotfiles' | 'agent';

/**
 * Runtime, in parts as Remote's page is: this device and what can go from it and come to it, the Prompts
 * running (offered while there is one), the environments, and the dotfiles. Hidden parts go on: a Prompt runs,
 * what is read is read again, a dotfile half written stays.
 */
export function runtime(ctx: Context): Node[] {
  const page = parts<RuntimePart>('runtime', [
    {id: 'device', label: isNative ? t('This device') : t('This browser')}, {id: 'prompts', label: t('Running Prompts')},
    {id: 'environments', label: t('Environments')}, {id: 'dotfiles', label: t('Dotfiles')}, {id: 'agent', label: t('Agent')}], undefined, 'quiet');
  const capacity = h('div', {class: 'runtime-capacity'}, h('p', {class: 'muted'}, t('Calculating storage…')));
  const inventory = h('div', {class: 'runtime-scroll'});
  const holder = h('section', {class: 'section device-part', 'aria-label': isNative ? t('This device') : t('This browser')}, capacity, inventory);
  // Read into the same viewport. Coming back from another place, or another tab, keeps the reading position.
  const person = connection()?.user ?? null;
  let readAt = inventoryReading?.person === person ? inventoryReading.y : 0;
  let restore = readAt > 0;
  const remember = () => {
    if (!inventory.clientHeight || restore) return;
    readAt = inventory.scrollTop;
    inventoryReading = {person, y: readAt};
  };
  inventory.addEventListener('scroll', remember, {passive: true});
  const laid = new ResizeObserver(() => {
    if (!inventory.isConnected) { laid.disconnect(); return; }
    if (restore && inventory.clientHeight) { restore = false; inventory.scrollTop = readAt; remember(); }
  });
  laid.observe(inventory);
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
        // A busy row can lose its focused button to the enclosing tabpanel before its read comes back.
        const samePart = onSheet || at === page.panel('device');
        const requested = samePart || at === document.body ? requestedFocus : undefined;
        const key = requested ?? (onSheet && at instanceof HTMLElement ? at.dataset.spaceFocus : undefined);
        requestedFocus = undefined;
        remember();
        const next = device(ctx, u, last, (r, focus) => { last = r; requestedFocus = focus; read(); });
        capacity.replaceChildren(next.capacity);
        inventory.replaceChildren(next.inventory);
        restore = !inventory.clientHeight;
        if (!restore) { inventory.scrollTop = readAt; remember(); }
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
      capacity.replaceChildren(h('p', {class: 'error'}, t('Storage calculation failed ({why})', {why: errorText(e)})));
      inventory.replaceChildren();
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
  // Each part is its own horizontal face; its reading scroll stays with it while it is hidden.
  const sheet = (part: RuntimePart, content: HTMLElement) => {
    const panel = page.panel(part);
    panel.classList.add('runtime-panel');
    panel.tabIndex = 0;
    panel.append(h('div', {class: 'runtime-face'}, part === 'device'
      ? content : h('div', {class: 'runtime-reading'}, content)));
    return panel;
  };
  // More about the same device, at the same reading edge; the inactive parts stay live.
  const environments = h('div', {class: 'runtime-leaf runtime-environments'},
    h('section', {class: 'section', 'aria-labelledby': 'env-title'}, h('h2', {id: 'env-title'}, t('Active environment')), environment()),
    isNative ? null : desktopApp(), sshSection());
  const dotfiles = dotfilesSection(restarted, (n) => page.count('dotfiles', n));
  // The Agent's key is local; dotfiles remain the person's on every device.
  const head = h('header', {class: 'runtime-masthead'}, h('h1', {}, t(purpose('runtime').label)));
  // The corner belongs to the desk. Only the current view is on the paper, as on its neighbouring desks.
  placesMenu(head, 'runtime', id => void ctx.go(id), {find: deskSearch(ctx),
    commands: () => ctx.placeCommands?.(['runtime']) ?? []});
  return [head, h('div', {class: 'runtime-work'},
    h('div', {class: 'part-bar runtime-tabs'}, page.switch),
    h('div', {class: 'runtime-paper'},
      sheet('device', holder), sheet('prompts', running), sheet('environments', environments),
      sheet('dotfiles', dotfiles), sheet('agent', agentSection())))];
}
