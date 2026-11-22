// Exec authority is the calling process's filesystem and credentials, not a
// translated artifact or a path looked up again in the embedding's Vfs.
import {MAY, may} from '../cred.ts';
import {E, File, FsError, MNT, WALK, pathOf, walk} from '../fs.ts';
import type {Found} from '../fs.ts';
import type {Proc} from '../parts.ts';

export class ImageSourceChangedError extends Error {
  constructor() { super('Executable source changed during image preparation'); this.name = 'ImageSourceChangedError'; }
}
export function sourceRevision(node: File, revision: number): void {
  if (node.version !== revision) throw new ImageSourceChangedError();
}

export class ExecPreparationChangedError extends Error {
  constructor() { super('Exec preparation lost its calling process or authority'); this.name = 'ExecPreparationChangedError'; }
}

/** The calling context required for pathname permission and source checks. */
export interface ExecSourceOwner extends Pick<Proc, 'readIdentity' | 'fs' | 'root' | 'cred' | 'ns' | 'noNewPrivs' | 'call'> {
  readonly own: object | undefined;
  readonly kernel: {readonly executionEpoch: object};
}

/** An unpublished initial process has no task until its exec is planned. */
export function execScope(process: ExecSourceOwner): () => void {
  const identity = process.readIdentity(), task = process.own;
  const kernel = process.kernel, executionEpoch = kernel.executionEpoch;
  const {fs, ns, cred, noNewPrivs, call} = process, {root, pwd} = fs;
  const rootMount = root.mnt, rootNode = root.node, cwdMount = pwd.mnt, cwdNode = pwd.node, mountSpace = ns.mnt;
  return () => {
    identity();
    if (kernel.executionEpoch !== executionEpoch || (task && task !== process.own) || process.fs !== fs || fs.root !== root || fs.pwd !== pwd ||
        root.mnt !== rootMount || root.node !== rootNode || pwd.mnt !== cwdMount || pwd.node !== cwdNode ||
        process.call !== call || process.ns !== ns || ns.mnt !== mountSpace || process.cred !== cred || process.noNewPrivs !== noNewPrivs)
      throw new ExecPreparationChangedError();
  };
}

export interface ExecSource {
  readonly at: Found & {node: File};
  readonly describe: () => string;
  check(): void;
}

/** Settle a possibly dirty source mapping before capturing its revision. */
export function execSource(process: ExecSourceOwner, path: string, scope: () => void, fromRoot = false): ExecSource {
  let at: Found | number;
  try {
    at = fromRoot
      ? walk(process, path, process.fs.root, WALK.FOLLOW | WALK.IN_ROOT | WALK.NO_MAGICLINKS)
      : walk(process, path, process.fs.pwd);
  }
  finally { scope(); }
  if (typeof at === 'number') throw new FsError(at);
  const {node, mnt} = at;
  if (!node) throw new FsError(E.NOENT);
  if (!(node instanceof File)) throw new FsError(node.isDir ? E.ACCES : E.NOEXEC);
  const authorized = (): void => {
    if (!(node.mode & 0o111) || !may(process.cred, node, MAY.EXEC) || mnt.flags & MNT.NOEXEC) throw new FsError(E.ACCES);
  };
  authorized();
  const {space, parent, point} = mnt;
  try { if (node.maps) node.settle(); }
  finally { scope(); }
  const revision = node.version;
  const check = (): void => {
    scope();
    sourceRevision(node, revision);
    if (mnt.space !== space || mnt.parent !== parent || mnt.point !== point) throw new ExecPreparationChangedError();
    authorized();
  };
  check();
  const resolved = {...at, node};
  return {at: resolved, check, describe: () => pathOf(process.fs.root, mnt, node, resolved.parent, resolved.name)};
}
