// One canonical WebAssembly byte region with direct function-body views.

import { openFunctionRegions } from './function-regions.js';
import { openPageBundle } from './page-fabric.js';
import { openPhysicalPages } from './physical-pages.js';
import { executeGuestFunction, executeStateStep } from './vm.js';

export async function openPagedWasm(entry, manifestUrl, options = {}) {
  const delivery = entry?.delivery;
  if (!entry || !delivery) throw new Error('paged WebAssembly delivery is missing');
  const [code, regions, steps] = await Promise.all([
    openPageBundle({
      url: new URL(delivery.file, manifestUrl).href,
      prefixBytes: delivery.prefix_bytes,
      prefixSha256: delivery.prefix_sha256,
      objectSha256: entry.sha256,
      wavePages: options.wavePages ?? 1,
      cachePages: options.cachePages ?? 4,
    }),
    openFunctionRegions(entry, manifestUrl),
    openPhysicalPages(entry, manifestUrl),
  ]);
  if (code.length !== entry.bytes || regions.moduleBytes !== entry.bytes) {
    code.release();
    regions.release();
    throw new Error('paged WebAssembly views disagree on module length');
  }
  return {
    length: code.length,
    body: (functionIndex) => regions.body(functionIndex),
    async invoke(functionIndex, args = [], quantum = 1 << 16) {
      const physical = steps
        ? await steps.stateStep(functionIndex, 0, 0)
        : null;
      if (physical) {
        const cut = await executeStateStep(
          physical.source, physical.offset, physical.length,
          args, [], { initializeLocals: true },
        );
        return cut.stack.length ? cut.stack[cut.stack.length - 1] : 0n;
      }
      return executeGuestFunction(code, regions, functionIndex, args, quantum);
    },
    layout() {
      return {
        code: code.layout(), functions: regions.layout(),
        steps: steps ? steps.layout() : null,
      };
    },
    release() {
      code.release();
      regions.release();
      if (steps) steps.release();
    },
  };
}
