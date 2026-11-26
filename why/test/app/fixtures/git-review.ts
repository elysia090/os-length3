// Keep the actual Git paper, buttons, diff, history and CSS; omit the shell,
// Prompt and guest. The Playwright test bridges core requests to the app's
// real WASM core running against an isolated in-process Remote.
import {useCore} from '../../../api/host.ts';
import type {Ask} from '../../../api/client.ts';
import {loadState} from '../../../home/state.ts';
import * as history from '../../../repo/history.ts';
import {readIssues} from '../../../repo/issues.ts';
import {issueStore} from '../../../repo/issue-store.ts';
import {issuePaper, issueSteps, type IssueEvents, type RepoState} from '../../../app/pages/git/issue.ts';
import {h} from '../../../app/ui/dom.ts';
import '../../../app/styles/index.css';

declare global {
  interface Window {
    gitAsk: Ask;
    gitPaper: {read(): Promise<void>};
  }
}
const repo = 'hello';
const events: IssueEvents = {open: () => {}, moved: () => {}};
let generation = 0;
async function read() {
  const id = ++generation;
  const [[issue], [standing], draft] = await Promise.all([
    readIssues(issueStore, repo), history.standings([repo]), history.changes(repo),
  ]);
  if (id !== generation) return;
  if (!issue || !standing || standing instanceof Error) throw new Error('Git fixture could not read the actual work');
  const state: RepoState = {...standing, uncommitted: draft.folders.filter((f) => f.folder !== 'issue').reduce((n, f) => n + f.files.length, 0)};
  const again = () => void read();
  const {box, history: lane} = issuePaper(issue, state, events, again);
  document.querySelector('main')?.replaceChildren(
    h('div', {class: 'git-side'}, h('p',{class:'side-name'}, repo, h('br',{}),'main'),
      h('div', {class: 'git-switch'}, issueSteps(issue, state, events, again))),
    h('section', {class:'section'},
      h('div', {class:'issue-slot', 'aria-current': 'true'}, h('article', {class:'issue-card'}, box),
        lane ? h('div', {class:'issue-after'}, h('div', {class:'issue-run'}, lane)) : null)));
}
useCore((name, args) => window.gitAsk(name, args));
await loadState(['remote']);
window.gitPaper = {read};
await read();
