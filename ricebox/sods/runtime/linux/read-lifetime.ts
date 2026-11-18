/** Host callback invalidated a pending ordinary-file read. Not a guest errno or
 * an ordinary partial read: the execution owner must retire the affected process.
 */
export class ReadLifetimeError extends Error {
  cleanupFailure?: unknown;
  constructor() { super('Pending file read lost its process, memory or offset identity'); }
}
const epochs = new WeakMap<object, object>();
export const memoryEpoch = (memory: object | null): object | undefined => memory ? epochs.get(memory) : undefined;
export function retireMemoryView(memory: object | null): void { if (memory) epochs.set(memory, {}); }
