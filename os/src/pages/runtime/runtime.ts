import {h} from '../../ui/dom.ts';
import {isNative, type Freed} from '../../app/host.ts';
import {t} from '../../i18n.ts';
import {onSync} from '../../remote/lifecycle.ts';
import {readSpace} from '../../app/space.ts';
import {pageHead, parts} from '../common.ts';
import type {Context} from '../context.ts';
import {allSessions} from '../bench/terminal.ts';
import {errorText} from '../../app/errors.ts';
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
    {id: 'device', label: isNative ? t('This device') : t('This browser')}, {id: 'prompts', label: t('Prompts running')},
    {id: 'environments', label: t('Environments')}, {id: 'dotfiles', label: t('Dotfiles')}, {id: 'agent', label: t('Agent')}]);
  const holder = h('div', {}, h('section', {class: 'section'}, h('p', {class: 'muted'}, t('Measuring…'))));
  let last: Freed | null = null;
  const read = (): void => void readSpace(allSessions().filter(([, s]) => s.running).map(([repo]) => repo)).then((u) => {
    // A repo's gear list out is not drawn away under the pointer: read again once it is put away.
    if (holder.isConnected && holder.querySelector('.repo-gear-pop:not([hidden])')) { setTimeout(read, 1000); return; }
    holder.replaceChildren(device(ctx, u, last, (r) => { last = r; read(); }));
  },
    (e) => holder.replaceChildren(h('section', {class: 'section'}, h('p', {class: 'error'}, t('Could not measure ({why})', {why: errorText(e)})))));
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
  // The environments and, on the web, the desktop app one to their right: how this device runs, or becomes the
  // app. SSH, how it is reached, under the two. (The desktop app is offered on the web; the app itself is it.)
  page.panel('environments').append(h('div', {class: 'section-row'},
    h('section', {class: 'section', 'aria-labelledby': 'env-title'}, h('h2', {id: 'env-title'}, t('Environment in effect')), environment()),
    ...(isNative ? [] : [desktopApp()])), sshSection());
  page.panel('dotfiles').append(dotfilesSection(restarted, (n) => page.count('dotfiles', n)));
  // The Agent's key apart from the dotfiles: a dotfile is the person's, on every device; the key is this device's alone.
  page.panel('agent').append(agentSection());
  return [pageHead('runtime'), h('div', {class: 'part-bar'}, page.switch),
    page.panel('device'), page.panel('prompts'), page.panel('environments'), page.panel('dotfiles'), page.panel('agent')];
}
