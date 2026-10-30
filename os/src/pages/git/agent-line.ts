import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {pop} from '../../ui/glide.ts';
import {agentsOn, harnessName, lineOf, onAgents, type AgentSession} from '../../repos/agents.ts';
import type {Issue} from '../../repos/issues.ts';

// An agent at work on an issue, in its box, as the agent's hooks say it (repos/agents.ts): who, what it does now, and
// whether it waits for the person. Its dot breathes while it works, beats at each tool it uses, and holds still in
// yellow while it waits: the box is where one sees the work go, whatever program does it.

/** How long an element is given to be put on screen before it counts as gone. */
const PLACED = 2000;

function row(s: AgentSession): HTMLElement {
  const waits = s.state === 'waits';
  return h('div', {class: `agent-row ${s.state}`, 'data-session': `${s.harness}/${s.session}`},
    h('span', {class: 'agent-dot', 'aria-hidden': 'true'}),
    h('span', {class: 'agent-who'}, harnessName(s.harness)),
    s.doing ? h('span', {class: 'agent-doing'}, s.doing) : null,
    waits ? h('span', {class: 'agent-waits'}, t('waits for you')) : null);
}

/** The agents at work on `issue`, kept as they go; hidden while none is. */
export function agentLine(issue: Issue): HTMLElement {
  const el = h('div', {class: 'agent-line', role: 'status', 'aria-live': 'polite'});
  el.hidden = true;
  const line = lineOf(issue.file);
  const made = Date.now();
  let was = '';
  onAgents((events) => {
    const on = agentsOn(issue.repo, line);
    const now = JSON.stringify(on.map((s) => [s.harness, s.session, s.state, s.doing]));
    if (now !== was) {
      was = now;
      el.hidden = !on.length;
      el.replaceChildren(...on.map(row));
    }
    // Each tool it takes up: a beat of its dot.
    for (const e of events) {
      if (e.repo !== issue.repo || e.line !== line || e.kind !== 'tool') continue;
      const dot = el.querySelector<HTMLElement>(`[data-session="${CSS.escape(`${e.harness}/${e.session}`)}"] .agent-dot`);
      if (dot) pop(dot, .3, 260);
    }
  }, () => el.isConnected || Date.now() - made < PLACED);
  return el;
}

/** A neighbour's head: a dot when an agent is at its issue, so the row shows where agents work. */
export function agentMark(issue: Issue): HTMLElement {
  const el = h('span', {class: 'agent-dot agent-mark', 'aria-hidden': 'true'});
  el.hidden = true;
  const line = lineOf(issue.file);
  const made = Date.now();
  onAgents(() => {
    const on = agentsOn(issue.repo, line);
    el.hidden = !on.length;
    el.classList.toggle('waits', on.length > 0 && on.every((s) => s.state === 'waits'));
  }, () => el.isConnected || Date.now() - made < PLACED);
  return el;
}
