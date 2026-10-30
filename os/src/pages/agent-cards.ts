import {h} from '../ui/dom.ts';
import {t} from '../i18n.ts';
import {arrive} from '../ui/glide.ts';
import {agentNow, harnessName, onAgents, onTask, tasksNow, type Task} from '../repos/agents.ts';
import {issueName} from '../repos/issues.ts';
import {personBadge} from './pane.ts';
import {errorText} from '../app/errors.ts';
import {grant} from './runtime/prompts.ts';

// What the agent brings to the person, in the right pane, as word from someone comes there (pane.ts paneWord): what
// it can take, what it asks, what it has to look at (the heaviest first), what it could not do and the one thing
// that lets it. Nothing of how it goes about it (its turn, its order, its runs): those are its own. A card comes in
// at an edge of the person's attention, never while they type: one that comes meanwhile waits until they stop.

/** Typing stopped this long ago is an edge: what came meanwhile comes in then. */
const PAUSE = 1500;
let typed = 0;
if (typeof addEventListener === 'function') {
  addEventListener('keydown', (e) => { if ((e.target as HTMLElement | null)?.closest?.('input, textarea, [contenteditable]')) typed = Date.now(); }, {capture: true, passive: true});
}

/** The issue a task is for, as a person calls it (#3), else its repo. */
const about = (k: Task) => issueName({n: Number(/^issue\/0*(\d+)\.md$/.exec(k.issue ?? '')?.[1] ?? NaN) || null}) || k.repo;

function button(text: string, primary: boolean, act: () => Promise<unknown>): HTMLButtonElement {
  const b = h('button', {type: 'button', class: primary ? 'button small-button primary' : 'button small-button'}, text) as HTMLButtonElement;
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    b.disabled = true;
    try { await act(); } catch (err) { b.disabled = false; b.title = errorText(err); }
  });
  return b;
}

/** One task as the person meets it: who, what about, its words, and the deed that goes on with it. */
function card(k: Task, open: (repo: string, issue: string) => void): HTMLElement {
  const agent = harnessName(agentNow() ?? '');
  const at = about(k);
  const found = k.found ?? [];
  const where = (f: {path?: string; line?: number}) => (f.path ? `${f.path}${f.line ? `:${f.line}` : ''} · ` : '');
  let head = '';
  let quote: Node[] = [];
  const acts: HTMLElement[] = [];
  const away = () => button(t('Put away'), false, () => onTask(k.id, 'drop'));
  const look = () => button(t('Look'), true, async () => open(k.repo, k.issue ?? ''));
  if (k.state === 'offered') {
    head = k.deed === 'fix' ? t('{agent} can make the tests of {at} pass', {agent, at}) : t('{agent} can take {at}', {agent, at});
    quote = [document.createTextNode(k.words)];
    acts.push(button(t('Hand it over'), true, () => onTask(k.id, 'take')), button(t('Later'), false, () => onTask(k.id, 'drop')));
  } else if (k.state === 'asking') {
    head = t('{agent} asks about {at}', {agent, at});
    quote = (k.questions ?? []).map((q) => h('span', {class: 'agent-question'}, q));
    const field = h('input', {type: 'text', class: 'field agent-reply', 'aria-label': t('Your answer'), placeholder: t('Your answer')}) as HTMLInputElement;
    const send = button(t('Answer'), true, async () => { if (field.value.trim()) await onTask(k.id, 'reply', field.value); });
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); send.click(); } });
    acts.push(field, send);
  } else if (k.state === 'ready' && k.deed === 'review') {
    head = found.length ? t('{agent} read {at}: the heaviest first', {agent, at}) : t('{agent} read {at}: nothing to change', {agent, at});
    quote = found.length ? found.slice(0, 3).map((f) => h('span', {class: 'agent-finding'}, where(f), f.text)) : [document.createTextNode(k.said ?? '')];
    acts.push(look(), away());
  } else if (k.state === 'ready' && k.deed === 'tests') {
    head = t('The tests fail on {at}', {at});
    quote = found.slice(0, 2).map((f) => h('span', {class: 'agent-finding'}, f.text));
    acts.push(look(), away());
  } else if (k.state === 'ready' && k.deed === 'ask') {
    head = t('{agent} answered', {agent});
    quote = [h('span', {class: 'muted'}, k.words), h('span', {}, k.said ?? '')];
    acts.push(away());
  } else if (k.state === 'ready') {
    head = t('{agent} is done with {at}', {agent, at});
    quote = [document.createTextNode(k.said ?? '')];
    acts.push(look(), away());
  } else if (k.state === 'stopped') {
    head = t('{agent} could not go on with {at}', {agent, at});
    // The network it needs is asked for here, once: given, it is the repo's from then on, and the work goes on.
    const network = k.fix === `l3 network on ${k.repo}`;
    quote = [document.createTextNode(k.said ?? ''), ...(k.fix && !network ? [h('code', {class: 'agent-fix'}, k.fix)] : [])];
    acts.push(network ? button(t('Give {repo}\'s Prompt the network', {repo: k.repo}), true, async () => { await grant(k.repo, true); await onTask(k.id, 'take'); })
      : button(t('Try again'), true, () => onTask(k.id, 'take')), away());
  }
  return h('div', {class: `agent-card lately-row ${k.state}`, 'data-task': String(k.id)},
    h('span', {class: 'lately-what'}, personBadge(agent), h('span', {class: 'lately-name'}, head), h('span', {class: 'lately-place'}, k.repo)),
    quote.length ? h('span', {class: 'lately-quote agent-quote'}, ...quote) : null,
    h('div', {class: 'agent-acts'}, ...acts));
}

/** What the person meets of a task: an offer, a question, something to look at, what could not go on. */
const shown = (k: Task) => ['offered', 'asking', 'ready', 'stopped'].includes(k.state);

/**
 * The agent's cards, newest last, kept as they change; `open` goes to an issue (Git, at it). A card kept as it was is
 * left standing (a reply being written in it stays); one that is new slides in from the window's edge.
 */
export function agentCards(open: (repo: string, issue: string) => void): HTMLElement {
  const list = h('section', {class: 'agent-cards', 'aria-label': t('From your agent'), 'aria-live': 'polite'});
  const drawn = new Map<number, {at: number; el: HTMLElement}>();
  let later = 0;
  const paint = () => {
    const since = Date.now() - typed;
    if (since < PAUSE) { clearTimeout(later); later = window.setTimeout(paint, PAUSE - since); return; }
    const now = tasksNow().filter(shown);
    for (const [id, d] of drawn) if (!now.some((k) => k.id === id)) { d.el.remove(); drawn.delete(id); }
    for (const k of now) {
      const was = drawn.get(k.id);
      if (was && was.at === k.updated) continue;
      const el = card(k, open);
      if (was) was.el.replaceWith(el); else list.append(el);
      drawn.set(k.id, {at: k.updated, el});
      if (!was && list.dataset.shown) arrive(el, 1, 'x', 32, 360);
    }
  };
  const made = Date.now();
  onAgents(paint, () => list.isConnected || Date.now() - made < 2000);
  requestAnimationFrame(() => { list.dataset.shown = '1'; });
  return list;
}
