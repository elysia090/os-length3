import {bytes, h} from '../../ui/dom.ts';
import type {Stopped} from '../../app/host.ts';
import {t, tn} from '../../i18n.ts';
import {allSessions, type Session} from '../bench/terminal.ts';
import {getState, setState} from '../../home/state.ts';
import {onRenamed} from '../../repos/repos.ts';
import {errorText} from '../../app/errors.ts';
import {button, card} from './parts.ts';

// Runtime's Prompts running, each a small card: where it runs, the memory it holds, and Stop. Shown only when one
// runs (or one stopped here says what it gave back).

/** The repos whose Prompt was stopped from its card just now, until their card says so (and lights what it gave back). */
const stoppedNow = new Set<string>();

// Which repos' Prompts may reach the network: this device's grant (core's home `network`, which l3 reads too).
const granted = (): string[] => { try { return JSON.parse(getState('network') ?? '[]') as string[]; } catch { return []; } };
/** Give `repo`'s Prompts the network (from their next start), or take it. */
export async function grant(repo: string, on: boolean) {
  const all = new Set(granted());
  if (on) all.add(repo); else all.delete(repo);
  await setState('network', JSON.stringify([...all].sort()));
}
// A repo renamed keeps its grant under its new name.
onRenamed((from, to) => { if (granted().includes(from)) void grant(from, false).then(() => grant(to, true)).catch(() => {}); });

/**
 * The network for a Prompt on the root, as a plain switch: a namespace cannot
 * be given a network once made, so turning it on asks, then stops the Prompt
 * (it has the network from its next start); turning it off stops it at once.
 */
function networkSwitch(repo: string, s: Session, card: () => HTMLElement): HTMLElement {
  const on = granted().includes(repo);
  const sw = h('button', {type: 'button', class: 'power plain', role: 'switch', 'aria-checked': String(on),
    'aria-label': on ? t('Disable network for {repo} Prompt', {repo}) : t('Enable network for {repo} Prompt', {repo})}, h('span', {class: 'knob'})) as HTMLButtonElement;
  const error = h('p', {class: 'error small', role: 'alert'});
  sw.addEventListener('click', () => {
    const el = card();
    if (on) { void grant(repo, false).then(() => s.stop(), (e) => { error.textContent = errorText(e); }); return; }
    sw.setAttribute('aria-checked', 'true');
    const was = [...el.childNodes];
    const no = button(t('Cancel'), 'small-button'), yes = button(t('Grant access'), 'small-button primary');
    no.addEventListener('click', () => el.replaceChildren(...was, error));
    yes.addEventListener('click', () => void grant(repo, true).then(() => s.stop(), (e) => { el.replaceChildren(...was, error); error.textContent = errorText(e); }));
    el.replaceChildren(h('span', {class: 'card-title'}, repo),
      h('p', {class: 'muted small'}, t('Network access applies on next launch; stopping instance now.')),
      h('div', {class: 'card-foot'}, no, h('span', {class: 'grow'}), yes));
  });
  return h('div', {class: 'net-row'}, h('span', {class: 'muted small'}, t('Network')), sw, error);
}

/**
 * The Prompts running. `shown(n, any)` hears how many run and whether there is any to show (running, or stopped
 * here with what it gave back); `changed` hears when which repos have a Prompt running changes (one stopped,
 * started, or prepared), so what holds a repo is read again then, not at the next page.
 */
export function prompts(shown_: (running: number, any: boolean) => void = () => {}, changed: () => void = () => {}): HTMLElement {
  const section = h('section', {class: 'section prompts-part', 'aria-label': t('Running Prompts'), hidden: ''});
  let had = '';
  // Each session is watched once, for as long as the page is shown.
  const watched = new Map<Session, () => void>();
  const watch = (s: Session) => { if (!watched.has(s)) watched.set(s, s.watch(paint)); };
  let first = true;
  const paint = () => {
    if (!first && !section.isConnected) { for (const u of watched.values()) u(); watched.clear(); return; }
    first = false;
    // Every session is heard, so one still starting is shown once it runs.
    for (const [, s] of allSessions()) watch(s);
    // Running ones, and ones stopped here, with what stopping gave back.
    const shown = allSessions().filter(([, s]) => s.running || s.stopped);
    section.hidden = !shown.length;
    const running = shown.filter(([, s]) => s.running).length;
    shown_(running, shown.length > 0);
    // One prepared is read again too: what it holds stays now because it runs, and says so.
    const now = shown.filter(([, s]) => s.running).map(([repo, s]) => (s.preparing ? `${repo} preparing` : repo)).sort().join('\n');
    if (now !== had) { const before = had; had = now; if (before || now) changed(); }
    section.replaceChildren(h('div', {class: 'grid small-grid'}, ...shown.map(([repo, s]) => {
      watch(s);
      return !s.running && s.stopped ? stoppedCard(repo, s.stopped) : runningCard(repo, s);
    })));
  };
  paint();
  return section;
}

/** A Prompt stopped here: what stopping it gave back, and in how long, or how many of its processes are left. */
function stoppedCard(repo: string, st: Stopped): HTMLElement {
  // Stopped just now from here: what it gave back is lit a moment, the reward for stopping it.
  const now = !st.left && stoppedNow.delete(repo);
  return card(repo, [st.left ? tn('{n} remaining', '{n} remaining', st.left)
    : `${t('Stopped · Freed {size}', {size: bytes(st.before.memory)})}${st.ms !== null ? ` · ${st.ms} ms` : ''}`], null, now ? 'quiet just-stopped' : 'quiet');
}

/** A Prompt running: where it runs and the memory it holds, what it gave back, the root's network; Free and Stop. */
function runningCard(repo: string, s: Session): HTMLElement {
  const stop = button(t('Stop'), 'small-button');
  stop.addEventListener('click', () => { stoppedNow.add(repo); s.stop(); });
  // In a browser, what it keeps for programs it ran can go without stopping it.
  const free = s.spare ? button(t('Free {size}', {size: bytes(s.spare)}), 'small-button') : null;
  free?.addEventListener('click', () => s.free());
  // Being prepared (.packages, .setup), what it holds is what prepares it; Stop ends that too.
  const processes = tn('{n} process', '{n} processes', s.processes);
  const on = s.on !== 'root' ? 'l3' : s.preparing ? `root · ${t('Provisioning (.packages, .setup)')} · ${processes}` : `root · ${processes}`;
  const lines: (string | Node)[] = [[on, s.memory ? bytes(s.memory) : ''].filter(Boolean).join(' · ')];
  if (s.freed !== null) lines.push(t('Freed {size}', {size: bytes(s.freed)}));
  // Only the root's Prompt can have a network: in a browser its programs have no sockets at all.
  let el: HTMLElement | null = null;
  if (s.on === 'root') lines.push(networkSwitch(repo, s, () => el!));
  // 空ける sits at the left as it does on every card (Remote's off one too); Stop at the right.
  el = card(repo, lines, null);
  el.append(h('div', {class: 'card-foot'}, free, h('span', {class: 'grow'}), stop));
  return el;
}
