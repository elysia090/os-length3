/** Additive lazy-source profile. It never asks the legacy byte-bearing hot path. */
import type {PreparedExecutable, PreparedRoot, More} from './root-types.ts';
import type {Translation} from '../format/manifest.ts';
import {retireRootWorker} from './retire-worker.ts';

type Box = {config: string; words: string[]};
type Reached = {list: More[]; saved: number; timer: number; url: string};
export interface ExecutionServices {
  first: readonly string[];
  load(): Promise<Omit<PreparedRoot, 'executables'>>;
  executable(root: Omit<PreparedRoot, 'executables'>, translation: Translation, quiet: boolean): Promise<{value: PreparedExecutable; moreURL: string; reached: More[]} | null>;
  worker(): Worker;
  save(reached: Reached): void;
  ready?(): void;
  failed?(error: unknown): void;
}
export function createExecutionProfile(services: ExecutionServices) {
  let loading: Promise<PreparedRoot> | null = null;
  const later = new Map<string, Map<string, PreparedExecutable>>();
  const extras = new Map<string, Reached>();
  const listeners = new Set<(value: PreparedExecutable) => void>();
  const warming = new Map<string, Promise<void>>();
  const rootOf = new WeakSet<PreparedRoot>();
  const check = (root: PreparedRoot) => { if (!rootOf.has(root)) throw new Error('Prepared root belongs to another execution profile'); };
  const withMore = (value: PreparedExecutable): PreparedExecutable => ({...value, more: extras.get(value.key)?.list ?? []});
  const adopt = (result: NonNullable<Awaited<ReturnType<ExecutionServices['executable']>>>) => {
    if (!extras.has(result.value.key)) extras.set(result.value.key, {list: result.reached, saved: result.reached.length, timer: 0, url: result.moreURL});
    return result.value;
  };
  const load = (): Promise<PreparedRoot> => loading ??= (async () => {
    const base = await services.load();
    const first = base.index.translations.filter(t => services.first.includes(t.path));
    const values = await Promise.all(first.map(t => services.executable(base, t, false)));
    const root: PreparedRoot = {...base, executables: [...new Map(values.filter(v => v !== null).map(value => [value.value.key, adopt(value)])).values()]};
    rootOf.add(root);
    services.ready?.();
    return root;
  })().catch(error => { loading = null; services.failed?.(error); throw error; });
  const executablesNow = (root: PreparedRoot): PreparedExecutable[] => {
    check(root);
    return [...new Map([...root.executables, ...(later.get(root.generation)?.values() ?? [])].map(value => [value.key, value])).values()].map(withMore);
  };
  const warm = (root: PreparedRoot): Promise<void> => {
    check(root);
    const previous = warming.get(root.generation);
    if (previous) return previous;
    const values = later.get(root.generation) ?? new Map<string, PreparedExecutable>();
    later.set(root.generation, values);
    const operation = (async () => {
      for (const translation of root.index.translations) {
        if (services.first.includes(translation.path)) continue;
        // Integrity errors remain visible through the returned diagnostic state,
        // not a compile fallback. They never publish an executable association.
        const result = await services.executable(root, translation, true);
        if (!result) continue;
        const value = adopt(result);
        if (root.executables.some(first => first.key === value.key) || values.has(value.key)) continue;
        values.set(value.key, value);
        for (const listener of [...listeners]) listener(withMore(value));
      }
    })();
    warming.set(root.generation, operation);
    void operation.catch(error => { failures.push(error); });
    return operation;
  };
  const failures: unknown[] = [];
  const hearLater = (listener: (value: PreparedExecutable) => void): (() => void) => {
    for (const values of later.values()) for (const value of values.values()) listener(withMore(value));
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const keepMore = (root: PreparedRoot, path: string, from: number, list: More[]): void => {
    check(root);
    const executable = executablesNow(root).find(e => e.path === path), entry = executable && extras.get(executable.key);
    if (!entry || !Number.isSafeInteger(from) || from < 0 || from > entry.list.length || from >= 256) return;
    entry.list = [...entry.list.slice(0, from), ...list].slice(0, 256);
    if (from < entry.saved) entry.saved = -1;
    services.save(entry);
  };
  let spare: {worker: Worker; generation: string; givenExecutables: Set<string>} | null = null;
  function readyWorker(root: PreparedRoot, rehearse: Box): void {
    check(root);
    if (spare?.generation === root.generation) return;
    if (spare) { const old = spare; spare = null; void retireRootWorker(old.worker).then(result => { for (const failure of result.failures) failures.push(failure); }, error => failures.push(error)); }
    const worker = services.worker(), executables = executablesNow(root);
    try {
      worker.postMessage({type: 'warm'});
      worker.postMessage({type: 'ready', profile: root.profile, generation: root.generation, executables,
        fileStore: root.fileStore, translator: root.translator, root: {index: root.index, url: root.url}, muk: root.muk, rehearse});
      spare = {worker, generation: root.generation, givenExecutables: new Set(executables.map(e => e.key))};
    } catch (error) {
      void retireRootWorker(worker).then(result => { for (const failure of result.failures) failures.push(failure); }, cleanup => failures.push(cleanup));
      throw error;
    }
  }
  function takeReady() { const result = spare; spare = null; return result; }
  return {load, executablesNow, warm, hearLater, keepMore, readyWorker, takeReady, failures: failures as readonly unknown[]};
}
