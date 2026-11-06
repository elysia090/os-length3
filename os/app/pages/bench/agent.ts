import {h} from '../../ui/dom.ts';
import {t} from '../../i18n/i18n.ts';
import {shownTree} from '../../repos/repos.ts';
import {AgentError, type Use} from '../../agent/ask.ts';
import {Agent, type Done, type Hands} from '../../agent/loop.ts';
import {boxSaid} from '../../repos/agents.ts';
import {LAND, paced, still} from '../../ui/glide.ts';
import {askChanged, asked} from './asks.ts';

// The box's Agent (box-modes.ts): something asked of it in the repo, worked on by the model the key kept on this
// device opens (agent/loop.ts), told what the person is looking at (the repo's top, the issue whose work it is, and
// the file in front with the caret's line, as it stands). It works behind the screen, through the OS's own calls: it
// reads the repo's files, runs its commands in a Prompt of its own that no one looks at (a build, the tests), and, on
// an issue's work only, writes files, which the screen shows changing where they are open (Forge, its diff). What it
// did comes into the right pane's flow under what it was asked, a line a step (read, ran and how that ended, edited),
// and its words last. It says what it does as any agent's hooks do (asked, each tool, its turn over: repos/agents.ts
// boxSaid), so wherever agents are shown at work (an issue's box in Git), it is too.

/** The box's Agent's session while the app runs: started once a repo is first asked about. */
const SESSION = `box-${Math.random().toString(36).slice(2, 10)}`;
const started = new Set<string>();

/** Of the file in front, the most the Agent is shown, in characters. */
const FILE_MOST = 24_000;

/** What the person is looking at, for the Agent: the file in front as it stands, and the caret's line in it. */
interface InFront { path: string; text: string; line: number }

/**
 * What the Agent is told before what it is asked: where it is asked from, what it can do there, the issue whose work
 * it is (`issue`: its file's text; null on main, where it only reads and runs), and what is in front of the person.
 */
export async function told(repo: string, front: InFront | null, issue: string | null = null): Promise<string> {
  const top = await shownTree(repo, '').catch(() => []);
  const lines = [
    `You are the Agent of length3 OS, asked from the box at the foot of the repo "${repo}".`,
    'You can read its files and run commands in a Prompt of your own in its top folder (sh, with make, cc, gdb and the repo\'s tests).',
    issue === null ? 'This is main: you do not write files here. Read, run, and say what should change.'
      : 'This is an issue\'s work, handed to you: write the files that must change. Run the build and the tests to see that it works before you say it is done.',
    'Say what you did, or answer, briefly and plainly, in the language you are asked in. Put code in fenced blocks.',
    `The repo's top: ${top.map((e) => (e.kind === 'dir' ? `${e.name}/` : e.name)).join(' ') || '(empty)'}`,
  ];
  if (issue !== null) lines.push('The issue:', '```', issue.slice(0, FILE_MOST), '```');
  if (front) {
    const cut = front.text.length > FILE_MOST;
    lines.push(`The file in front of the person: ${front.path}, the caret on line ${front.line}${cut ? ` (its first ${FILE_MOST} characters)` : ''}.`,
      '```', front.text.slice(0, FILE_MOST), '```');
  }
  return lines.join('\n');
}

/**
 * An answer as it reads: its words in paragraphs where a line is left empty (a list's lines one under another in
 * one), each fenced block a block of code (one not closed yet too).
 */
export function answerNodes(text: string): Node[] {
  return text.split(/^```[^\n]*\n?/m).flatMap((part, i): Node[] => {
    if (i % 2) return part ? [h('code', {class: 'answer-code'}, part.replace(/\n$/, ''))] : [];
    return part.split(/\n{2,}/).map((p) => p.replace(/^\n+|\n+$/g, '')).filter(Boolean).map((p) => h('p', {class: 'answer-p'}, p));
  });
}

/** What went wrong, as a person would read it: the key refused, too many asks, nobody reached, or the maker's words. */
function whyNot(e: unknown): string {
  if (!(e instanceof AgentError)) return t('Cannot connect to Agent');
  if (e.status === 401 || e.status === 403) return t('API key invalid; re-enter in Runtime');
  if (e.status === 429) return t('Rate limit exceeded; try again shortly');
  return e.message;
}

/** A file tool as a line of the Prompt's flow says it: what was done, and on what (a run is its own line there). */
function stepWords(name: string, path: string, done: Done | undefined, why: string): string {
  if (!done) return name === 'read' ? t('Could not read {path}: {why}', {path, why}) : t('Could not edit {path}: {why}', {path, why});
  if (done.tool === 'read') return t('Read {path}', {path});
  return done.tool === 'bash' ? '' : t('Edited {path} (+{added} −{removed})', {path, added: done.added, removed: done.removed});
}

/** A tool about to be used, in the words an agent's hooks say it in (the journal: an issue's box in Git shows it). */
function hookWords(name: string, args: Record<string, unknown>): string {
  const s = (k: string) => (typeof args[k] === 'string' ? args[k] as string : '');
  return name === 'bash' ? s('command') : `${name === 'read' ? 'read' : 'edited'} ${s('path')}`;
}

/**
 * An agent's hooks, outside its loop: started once per repo, asked, each tool about to be used, its turn over (with
 * its last words, or why it stopped), said as any agent's hooks say them (repos/agents.ts boxSaid).
 */
function hooks(agent: Agent, repo: string): void {
  if (!started.has(repo)) { started.add(repo); boxSaid(SESSION, repo, 'start'); }
  agent.subscribe((e) => {
    if (e.type === 'agent_start') boxSaid(SESSION, repo, 'prompt', e.question);
    else if (e.type === 'tool_execution_start') boxSaid(SESSION, repo, 'tool', hookWords(e.name, e.args));
    else if (e.type === 'agent_end') boxSaid(SESSION, repo, 'stop', e.error ? whyNot(e.error) : e.said);
  });
}

/** Where the Agent's work is written: the repo's Prompt's flow (terminal.ts Session). */
export interface Flow {
  note(head: string, words: string, go: (row: HTMLElement) => void): HTMLElement;
  answer(row: HTMLElement): HTMLElement;
}

/**
 * `question` (its line in the flow: `row`) worked on in `repo` with `use`, told `system`, done with `hands` (the
 * Agent's loop, agent/loop.ts). The flow follows what it does as it follows the person's work: what it runs is run in
 * the Prompt (`hands`), a line typed and its output as any; what it reads and edits, a line of its own each
 * (pressed, the file is opened with `open`); its words under the line they follow; refused, why, in the red. Until its
 * first step it waits under the question (styles: a quiet ellipsis). Its hooks are said beside, as any agent's are.
 */
export async function atWork(flow: Flow, row: HTMLElement, repo: string, use: Use, system: string, question: string, hands: Hands, open: (path: string) => void): Promise<void> {
  const agent = new Agent({use, system, hands});
  hooks(agent, repo);
  // Kept too, as it comes, for Agent's list under the search box (asks.ts).
  const ask = asked(repo, question);
  const kept = (part: (typeof ask.parts)[number]) => { ask.parts.push(part); askChanged(repo); };
  // The question first: its words go on from the box into their line (box-modes sendInto); nothing comes under that
  // line before they are there.
  const flying = row.getAnimations({subtree: true}).map((a) => a.finished);
  if (flying.length) await Promise.allSettled(flying);
  let waiting: HTMLElement | null = flow.answer(row);
  let last = row;
  const settle = () => { if (waiting && !waiting.childElementCount) waiting.remove(); waiting = null; };
  const words = (nodes: Node[], refused = false) => {
    const a = waiting ?? flow.answer(last);
    waiting = null;
    a.classList.remove('waiting');
    a.replaceChildren(...nodes);
    if (refused) a.classList.add('refused');
    if (!still()) a.animate([{opacity: 0, translate: '0 4px'}, {opacity: 1, translate: '0 0'}], {duration: paced(220), easing: LAND});
  };
  agent.subscribe((e) => {
    if (e.type === 'message_end') { words(answerNodes(e.text)); kept({kind: 'words', text: e.text}); return; }
    if (e.type !== 'tool_execution_end') return;
    settle();
    const path = typeof e.args.path === 'string' ? e.args.path : '';
    if (e.name === 'bash') { kept({kind: 'step', text: `$ ${hookWords(e.name, e.args)}`}); return; }
    const said = stepWords(e.name, path, e.done, e.result);
    kept({kind: 'step', text: said});
    last = flow.note('Agent', said, () => open(path));
  });
  try {
    const said = await agent.prompt(question);
    settle();
    if (!said.trim()) throw new AgentError(0, t('Agent returned no response'));
  } catch (e) {
    words([h('span', {class: 'answer-refused'}, whyNot(e))], true);
    ask.refused = whyNot(e);
  } finally {
    ask.done = true;
    askChanged(repo);
  }
}
