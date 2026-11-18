import type {Proc} from './parts.ts';

/** Host reentry changed fork's input. Not guest errno or automatic exit. */
export class ForkPreparationChangedError extends Error {
  constructor() { super('Fork preparation lost its input ownership'); this.name = 'ForkPreparationChangedError'; }
}

/** Bounded input-owner guard, not a deep snapshot or arbitrary raw mutation log. */
export function forkIdentity(p: Proc): () => void {
  const memoryIdentity = p.readIdentity(), task = p.task, image = p.image, fds = p.fds, location = p.fs;
  const root = location.root, pwd = location.pwd, umask = location.umask;
  const credentials = p.cred, spaces = p.ns, group = p.cgroup;
  return () => {
    try { memoryIdentity(); } catch { throw new ForkPreparationChangedError(); }
    if (p.task !== task || p.image !== image || p.fds !== fds || p.fs !== location
      || location.root !== root || location.pwd !== pwd || location.umask !== umask
      || p.cred !== credentials || p.ns !== spaces || p.cgroup !== group) throw new ForkPreparationChangedError();
  };
}

/** Preserve a prior refusal, but never turn changed ownership into guest errno.
 * The inner base boundary may already have reported the same invalidation. */
export function forkFailure(error: unknown, unchanged: () => void): never {
  try { unchanged(); }
  catch (changed) {
    if (error instanceof ForkPreparationChangedError
      || error instanceof AggregateError && error.errors.some(e => e instanceof ForkPreparationChangedError)) throw error;
    throw new AggregateError([error, changed], 'fork preparation failed and input ownership changed');
  }
  throw error;
}
