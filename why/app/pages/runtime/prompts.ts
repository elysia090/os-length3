import {grant, granted} from '../../../home/network.ts';
import {h} from '../../ui/dom.ts';
import {bytes} from '../../../text/format.ts';
import type {Stopped} from '../../../api/host.ts';
import {t, tn} from '../../../text/i18n.ts';
import {allSessions, sessionIfAny, stopPrompt, type Prompt} from '../bench/sessions.ts';
import {errorText} from '../../../api/errors.ts';
import {button} from './parts.ts';
import {wayOut} from '../../ui/way-out.ts';

// Runtime's Prompts are live rows: each has its own process count, memory, and actions.
const stoppedNow = new WeakSet<Prompt>();
const asked = new WeakMap<HTMLElement, Prompt>();

/**
 * The network for a Prompt on the root, as a plain switch: a namespace cannot
 * be given a network once made, so turning it on asks, then stops the Prompt
 * (it has the network from its next start); turning it off stops it at once.
 */
function networkSwitch(repo: string, session: Prompt, row: () => HTMLElement): HTMLElement {
  const on = granted().includes(repo);
  const sw = h('button', {type: 'button', class: 'power plain', role: 'switch', 'aria-checked': String(on),
    'aria-label': on ? t('Disable network for {repo} Prompt', {repo}) : t('Enable network for {repo} Prompt', {repo})}, h('span', {class: 'knob'})) as HTMLButtonElement;
  const error = h('p', {class: 'error small', role: 'alert'});
  sw.addEventListener('click', () => {
    const el = row();
    if (el.querySelector('.prompt-network-ask')) return;
    if (on) { void grant(repo, false).then(() => stopPrompt(repo)).catch((e) => { error.textContent = errorText(e); }); return; }
    const no = wayOut(button(t('Cancel'))), yes = button(t('Grant access'), 'primary');
    const ask = h('div', {class: 'prompt-network-ask', role: 'group', 'aria-label': t('Enable network for {repo} Prompt', {repo})},
      h('p', {class: 'muted small'}, t('Network access applies on next launch; stopping instance now.')),
      h('div', {class: 'card-foot'}, no, h('span', {class: 'grow'}), yes));
    const back = () => { ask.remove(); sw.focus(); };
    no.addEventListener('click', back);
    yes.addEventListener('click', () => {
      if (yes.disabled) return;
      no.disabled = yes.disabled = true;
      void grant(repo, true).then(() => stopPrompt(repo)).catch((e) => { back(); error.textContent = errorText(e); });
    });
    asked.set(ask, session);
    el.append(ask);
    no.focus();
  });
  return h('div', {class: 'net-row'}, h('span', {class: 'muted small'}, t('Network')), sw, error);
}

/**
 * The Prompts running. `shown(n, any)` hears how many run and whether there is any to show (running, or stopped
 * here with what it gave back); `changed` hears when which repos have a Prompt running changes (one stopped,
 * started, or prepared), so what holds a repo is read again then, not at the next page.
 */
export function prompts(shown_: (running: number, any: boolean) => void = () => {}, changed: () => void = () => {}): HTMLElement {
  const list = h('div', {class: 'prompt-list', role: 'list', 'aria-label': t('Running Prompts')});
  const section = h('section', {class: 'section runtime-leaf prompts-part', 'aria-label': t('Running Prompts'), hidden: ''},
    h('h2', {class: 'runtime-lead'}, t('Running Prompts')), list);
  let had = '';
  // Each session is watched once, for as long as the page is shown.
  const watched = new Map<Prompt, () => void>();
  const watch = (s: Prompt) => { if (!watched.has(s)) watched.set(s, s.watch(paint)); };
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
    const ask = list.querySelector<HTMLElement>('.prompt-network-ask');
    if (ask && asked.get(ask)?.running) return;
    const active = list.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const focus = active?.dataset.promptKey;
    list.replaceChildren(...shown.map(([repo, s]) => {
      const side = sideOf(repo, s);
      const distinct = !!sessionIfAny(repo, 'right') && !!sessionIfAny(repo);
      const name = distinctive(repo, distinct ? side : null);
      return !s.running && s.stopped ? stoppedRow(name, s, s.stopped) : runningRow(repo, side, name, s);
    }));
    if (focus) list.querySelector<HTMLElement>(`[data-prompt-key="${CSS.escape(focus)}"]`)?.focus({preventScroll: true});
  };
  paint();
  return section;
}

const sideOf = (repo: string, s: Prompt) => sessionIfAny(repo, 'right') === s ? 'right' : 'left';

const distinctive = (repo: string, side: 'left' | 'right' | null) =>
  h('span', {class: 'prompt-row-name'}, repo, side ? h('span', {class: 'muted prompt-side'}, side === 'left' ? t('Left') : t('Right')) : null);

function stoppedRow(name: HTMLElement, s: Prompt, st: Stopped): HTMLElement {
  const now = !st.left && stoppedNow.delete(s);
  return h('div', {class: now ? 'prompt-row just-stopped' : 'prompt-row', role: 'listitem'},
    name, h('span', {class: 'muted prompt-facts'}, st.left ? tn('{n} remaining', '{n} remaining', st.left)
      : `${t('Stopped · Freed {size}', {size: bytes(st.before.memory)})}${st.ms !== null ? ` · ${st.ms} ms` : ''}`));
}

function runningRow(repo: string, side: 'left' | 'right', name: HTMLElement, s: Prompt): HTMLElement {
  const stop = button(t('Stop'));
  stop.dataset.promptKey = `${repo}:${side}:stop`;
  const error = h('p', {class: 'error small', role: 'alert'});
  stop.addEventListener('click', () => {
    stop.disabled = true;
    stoppedNow.add(s);
    void s.stop().catch((e) => { stoppedNow.delete(s); stop.disabled = false; error.textContent = errorText(e); });
  });
  const free = s.spare ? button(t('Free {size}', {size: bytes(s.spare)})) : null;
  if (free) {
    free.dataset.promptKey = `${repo}:${side}:free`;
    free.addEventListener('click', () => s.free());
  }
  const processes = tn('{n} process', '{n} processes', s.processes);
  const on = s.preparing ? t('Provisioning (.packages, .setup)') : s.on === 'root' ? 'root' : 'why';
  let row: HTMLElement;
  const network = s.on === 'root' ? networkSwitch(repo, s, () => row) : null;
  const details = h('div', {class: 'prompt-facts muted'}, [on, processes].join(' · '),
    s.freed === null ? null : h('p', {}, t('Freed {size}', {size: bytes(s.freed)})), error);
  row = h('div', {class: 'prompt-row', role: 'listitem'}, name, details,
    s.memory ? h('span', {class: 'prompt-measure'}, bytes(s.memory)) : null,
    h('div', {class: 'prompt-row-actions'}, free, stop),
    network);
  return row;
}
