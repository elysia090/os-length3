// Types for remote.mjs, as os/scripts reads them (l3-runnable.ts: each thread in a Worker of its own).
import {Kernel} from './process.mjs';

export const canRunApart: () => boolean;
export class RemoteKernel extends Kernel {
  spawn(path: string, argv: string[], env: string[], cwd?: string): Promise<number>;
}
