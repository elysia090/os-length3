import {core} from '../host/host.ts';
import {t} from '../i18n/i18n.ts';
import type {Edited, Hands, Read, Written} from '../agent/loop.ts';
import {counts, lineOps} from './linediff.ts';
import {isIssues, plainPath, store} from './repos.ts';

// The Agent's hands on a repo's files (agent/loop.ts Hands, all but run, which is the Prompt's): each the core's rule
// (core agent/hands.rs, Pi's: a read's lines and where it goes on, an edit as pieces found once and replaced), the
// file read and written through the store, so Forge, File, Git and the Prompt's copy hear of it as of any write,
// written by `AGENT`. Only the repo's own files are written: never its issues (the OS keeps those), never a path
// that leaves it.

/** Who writes, for what watches the repo's files: the Agent, so an editor open on the file takes it in as written elsewhere. */
export const AGENT = 'agent';

/** `path`, if the Agent may write it in a repo; else why not. */
function writable(path: string): void {
  if (!plainPath(path) || isIssues(path)) throw new Error(t('{path} is not a file the Agent may write', {path}));
}

async function textOf(repo: string, path: string): Promise<string> {
  const c = await store.read(repo, path);
  if (c.text === null) throw new Error(t('{path} is not text', {path}));
  if (c.truncated) throw new Error(t('{path} is too large to edit here', {path}));
  return c.text;
}

/** What a run printed, as the model is given it (its last lines: core agent/hands.rs tail). */
export const tail = (output: string): Promise<string> => core<string>('agent_tail', {output});

/** The Agent's file hands on `repo`: reading always, editing and writing only on work handed to it (`writes`). */
export function fileHands(repo: string, writes: boolean): Omit<Hands, 'run'> {
  const read = (path: string, offset?: number, limit?: number) => core<Read>('agent_read', {repo, path, offset, limit});
  if (!writes) return {read};
  return {
    read,
    async edit(path, edits): Promise<Edited> {
      writable(path);
      const before = await textOf(repo, path);
      const e = await core<{text: string} & Omit<Edited, 'before'>>('agent_edit', {path, text: before, edits});
      await store.write(repo, path, e.text, AGENT);
      return {before, spans: e.spans, added: e.added, removed: e.removed};
    },
    async write(path, content): Promise<Written> {
      writable(path);
      const before = await textOf(repo, path).catch(() => null);
      if (before === null) {
        const at = path.lastIndexOf('/');
        await store.add(repo, at < 0 ? '' : path.slice(0, at), path.slice(at + 1), content, AGENT);
      } else await store.write(repo, path, content, AGENT);
      return {before, ...counts(lineOps(before ?? '', content))};
    },
  };
}
