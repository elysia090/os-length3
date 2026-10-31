import {h} from '../../ui/dom.ts';
import {t} from '../../i18n.ts';
import {store} from '../../repos/repos.ts';
import {ask, AgentError, type Use} from '../../agent/ask.ts';
import {boxSaid} from '../../repos/agents.ts';

// The box's Agent (box-modes.ts): a question about the repo, asked of the model the key kept on this device opens
// (agent/ask.ts), told what the person is looking at: the repo's top, and the file in front with the caret's line,
// as it stands (written in and not saved too). Its answer comes into the right pane's flow under the question, a few
// words at a time (output.ts answer), in the letters people write in, its code in the letters code is set in. It says
// what it does as any agent's hooks do (asked, its turn over: repos/agents.ts boxSaid), so wherever agents are shown
// at work (an issue's box in Git), it is too.

/** The box's Agent's session while the app runs: started once a repo is first asked about. */
const SESSION = `box-${Math.random().toString(36).slice(2, 10)}`;
const started = new Set<string>();

/** Of the file in front, the most the Agent is shown, in characters. */
const FILE_MOST = 24_000;

/** What the person is looking at, for the Agent: the file in front as it stands, and the caret's line in it. */
export interface InFront { path: string; text: string; line: number }

/** What the Agent is told before the question: where it is asked from, and what is in front of the person. */
export async function told(repo: string, front: InFront | null): Promise<string> {
  const top = await store.tree(repo, '').catch(() => []);
  const lines = [
    `You are the Agent of length3 OS, asked from the box at the foot of the repo "${repo}".`,
    'Answer briefly and plainly, in the language the question is written in. Put code in fenced blocks.',
    `The repo's top: ${top.map((e) => (e.kind === 'dir' ? `${e.name}/` : e.name)).join(' ') || '(empty)'}`,
  ];
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
export function whyNot(e: unknown): string {
  if (!(e instanceof AgentError)) return t('Cannot connect to Agent');
  if (e.status === 401 || e.status === 403) return t('API key invalid; re-enter in Runtime');
  if (e.status === 429) return t('Rate limit exceeded; try again shortly');
  return e.message;
}

/**
 * `question` about `repo` asked with `use`, told `system`: its answer drawn into `into` (under the question in the
 * flow) as it comes, once a frame; until the first words, it waits (styles: a quiet ellipsis); refused, why, in the
 * red. Asked and answered are said as an agent's hooks say them.
 */
export async function answer(into: HTMLElement, repo: string, use: Use, system: string, question: string): Promise<void> {
  if (!started.has(repo)) { started.add(repo); boxSaid(SESSION, repo, 'start'); }
  boxSaid(SESSION, repo, 'prompt', question);
  const out = into.closest<HTMLElement>('.term-out');
  let text = '', frame = 0;
  const draw = () => {
    frame = 0;
    // Read at the foot, it follows the answer down; scrolled up to read, it stays.
    const atFoot = !out || out.scrollHeight - out.clientHeight - out.scrollTop < 24;
    into.replaceChildren(...answerNodes(text));
    if (out && atFoot) out.scrollTop = out.scrollHeight;
  };
  try {
    for await (const words of ask(use, system, question)) {
      text += words;
      into.classList.remove('waiting');
      frame ||= requestAnimationFrame(draw);
    }
    if (!text.trim()) throw new AgentError(0, t('Agent returned no response'));
    boxSaid(SESSION, repo, 'stop', text);
  } catch (e) {
    cancelAnimationFrame(frame);
    if (text) draw();
    into.append(h('span', {class: 'answer-refused'}, whyNot(e)));
    boxSaid(SESSION, repo, 'stop', whyNot(e));
  } finally {
    into.classList.remove('waiting');
  }
}
