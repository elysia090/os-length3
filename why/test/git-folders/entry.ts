// Mount the real Git place and workbench, directing only reads to a tiny, in-memory core.
// No boot, connected service, guest, worker, writable store, or installed profile is used.
import {useCore} from '../../api/host.ts';
import {git, showIssue} from '../../app/pages/git/git.ts';
import type {Context} from '../../app/pages/kit/context.ts';

const issues: Record<string, Record<string, string>> = {
  hello: {
    '001.md': '# Fix first frame\nThe first issue is not the one left in the hand.\n',
    '002.md': '# Record frame timings\nKeep the selected words while visiting another repo.\n',
  },
  atlas: {},
  third: {'001.md': '# Third repo first issue\nThis one is not Atlas.\n'},
};
const requests: Array<{name: string; repo?: string}> = [];
const violations: string[] = [];
const query = new URLSearchParams(location.search);
const repos = query.has('single') ? ['hello'] : Object.keys(issues);
const place = document.querySelector('main')!;
let here = query.get('repo') ?? 'hello';
let delay: Promise<void> | null = null;
let release: (() => void) | null = null;
useCore(async (name, args) => {
  const repo = typeof args.repo === 'string' ? args.repo : undefined;
  requests.push({name, repo});
  if (name === 'repo_names') return {ok: repos};
  if (name === 'state_get' || name === 'agent_key') return {ok: null};
  if (name === 'agents') return {ok: []};
  if (name === 'repo_tree' && repo && repo in issues) {
    if (repo === 'atlas' && args.path === 'issue' && delay) await delay;
    // Issue paths are on main, not in another work's tree.
    if (args.path === 'issue' && args.main === true) {
      return {ok: Object.entries(issues[repo]!).map(([name, text]) => ({name, kind: 'file', size: text.length}))};
    }
    return {ok: []};
  }
  if (name === 'repo_read' && repo && args.main === true) {
    const text = issues[repo]?.[String(args.path).replace(/^issue\//, '')];
    if (text !== undefined) return {ok: {text, size: text.length, truncated: false}};
  }
  violations.push(name);
  return {error: 'Not a fixture read: ' + name};
});
const context: Context = {
  get repo() { return here; },
  get leftOff() { return null; },
  remember(repo) { here = repo; },
  async go(id) { violations.push('go:' + id); },
  openRepo(repo) { violations.push('openRepo:' + repo); },
  reading() {}, leftAt() {}, rerender() {},
};
const mount = () => place.replaceChildren(...git(context));
export interface Fixture {
  requests: typeof requests;
  violations: typeof violations;
  here(): string;
  holdAtlas(): void;
  releaseAtlas(): void;
  open(repo: string, issue: string): void;
}
declare global { interface Window { gitFoldersFixture: Fixture } }
window.gitFoldersFixture = {
  requests, violations, here: () => here,
  holdAtlas() { delay = new Promise((resolve) => { release = resolve; }); },
  releaseAtlas() { release?.(); delay = release = null; },
  open(repo, issue) { showIssue(repo, issue); mount(); },
};
mount();
