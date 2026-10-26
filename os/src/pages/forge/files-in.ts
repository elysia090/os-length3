import {t} from '../../i18n.ts';
import {store} from '../../repos/repos.ts';
import type {Drag} from './drag.ts';

// Files dragged in from the desktop go into the repo whose box they are let go over: into the folder of the file
// under the pointer, else its top; a name already there is never written over (the new one is "name (2)").

/** Where files let go at `event` would go: the repo of the box under the pointer, and the folder of the file there. */
function dropTarget(event: DragEvent) {
  const el = event.target as HTMLElement;
  const col = el.closest<HTMLElement>('.col');
  const file = el.closest<HTMLElement>('section.file')?.dataset.path ?? '';
  return col?.dataset.repo ? {repo: col.dataset.repo, col, dir: file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''} : null;
}

/** `name`, or the first of "name (2)", "name (3)"… that `taken` does not have (before its extension, if it has one). */
function freeName(name: string, taken: Set<string>): string {
  const dot = name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length;
  let free = name;
  for (let n = 2; taken.has(free); n++) free = `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
  return free;
}

/** `files` put in `repo`'s folder `dir`, none written over: the path of the first put in, or null for none. */
async function putIn(repo: string, dir: string, files: File[]): Promise<string | null> {
  const taken = new Set((await store.tree(repo, dir).catch(() => [])).map((e) => e.name));
  let first: string | null = null;
  for (const f of files) {
    const name = freeName(f.name, taken);
    taken.add(name);
    const path = dir ? `${dir}/${name}` : name;
    // A folder dragged in reads as no bytes at all: it is left where it was.
    const bytes = await f.arrayBuffer().then((b) => new Uint8Array(b), () => null);
    if (!bytes) continue;
    await store.put(repo, path, bytes);
    first ??= path;
  }
  return first;
}

/**
 * The center (`cols`) takes files from the desktop: over a box, the hint says where they would go; let go, they are
 * put there and the first is opened (`open`). A repo dragged on the page (`drag`) is not such a drag.
 */
export function takeFiles(cols: HTMLElement, drag: Drag, open: (repo: string, path: string) => void) {
  const filesIn = (event: DragEvent) => !drag.name && !!event.dataTransfer?.types.includes('Files');
  cols.addEventListener('dragover', (event) => {
    if (!filesIn(event)) return;
    const at = dropTarget(event);
    if (!at) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    const box = cols.getBoundingClientRect(), r = at.col.getBoundingClientRect();
    drag.hintAt(r.left - box.left, r.width, 'files', t('Put in {where}', {where: at.dir ? `${at.repo}/${at.dir}` : at.repo}));
  });
  cols.addEventListener('drop', (event) => {
    if (!filesIn(event)) return;
    drag.unhint();
    const at = dropTarget(event);
    const files = [...event.dataTransfer?.files ?? []];
    if (!at || !files.length) return;
    event.preventDefault();
    void putIn(at.repo, at.dir, files).then((first) => { if (first) open(at.repo, first); });
  });
}
