/** Explicit Linux/Node fixed-memory readonly root execution, not the default
 * Kernel or a general VM. Root metadata/path/OFD/source authority is Rust-owned.
 * The facade exposes no diagnostic memory, arbitrary inode open, or engine object.
 * The caller supplies the trusted current Linux core; shape/ABI are not provenance.
 */
import {isNode} from '../host.ts';
import {memoryHost} from './memory-host.ts';
export type {ExecutionBinding, PreparedArtifactRequest, PreparedFileLimits, PathExecutionOptions} from './memory-host.ts';
export interface ManagedRootCapacity {
  /** Bounds physical binding records AND non-reused startup/execution history.
   * Even a failed pre-image admission consumes its record; not a concurrency count. */
  memories: number;
  /** Pending effect records, not a byte/heap bound. */
  actions: number;
}
export type ManagedRootHost = Pick<ReturnType<typeof memoryHost>,
  'prepareRoot' | 'rootSource' | 'pathExecution' | 'runPath' |
  'stopWorker' | 'workerSettled' | 'workerEvidence'>;

export function createManagedRoot(module: WebAssembly.Module, capacity: ManagedRootCapacity): ManagedRootHost {
  if (!isNode || process.platform !== 'linux' || ![22, 24].includes(Number(process.versions.node.split('.')[0]))) {
    throw new Error('Managed root profile requires reviewed Linux Node 22 or 24');
  }
  const host = memoryHost(module, capacity.memories, capacity.actions);
  // One root per instance. Repeated execution is bounded by explicit capacities;
  // stop is only a request, settled host jobs are not physical-stop evidence.
  // Consumers must retain the owner and inspect workerEvidence before release.
  return Object.freeze({prepareRoot: host.prepareRoot, rootSource: host.rootSource,
    pathExecution: host.pathExecution, runPath: host.runPath, stopWorker: host.stopWorker,
    workerSettled: host.workerSettled, workerEvidence: host.workerEvidence});
}
