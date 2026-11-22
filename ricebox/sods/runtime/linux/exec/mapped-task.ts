// Register, Wasm-frame and retirement owner of one inline mapped Task.
// The Linux scheduler owns the task's queue, system calls and exit status.
import type {MappedTranslate} from '../../translation/mapped.ts';
import {Exit} from '../flow.ts';
import {E, FsError} from '../fs.ts';
import {MAPPED_VM_LIMIT, type MappedVm} from '../mapped-vm.ts';
import type {Mem, RegName} from '../parts.ts';
import {MappedDispatcher} from './mapped-dispatcher.ts';

/** An exit request unwinds execution; it is not yet a process exit. */
export class MappedExitRequest extends Exit {}

export const MAPPED_ARCH_PRCTL = 158;
const SET_FS = 0x1002n, GET_FS = 0x1003n, ADDRESS_LIMIT = BigInt(MAPPED_VM_LIMIT);
type Owner = Parameters<MappedVm['userMemory']>[0];

export class MappedTaskCpu {
  readonly memory: Mem;
  #vm: MappedVm;
  #dispatcher: MappedDispatcher;
  #kind: 'arena' | 'held-initial';
  #active = false;
  #retiring = false;
  #retired = false;
  #pending?: MappedExitRequest;
  #finishTidClear?: () => void;
  #firstEntry?: (pc: bigint) => void;

  constructor(memory: Mem, vm: MappedVm, compiler: MappedTranslate, imports: WebAssembly.ModuleImports,
      kind: 'arena' | 'held-initial') {
    if (memory.mappedVm !== vm || vm.memory !== memory) throw new TypeError('Invalid mapped Task backing');
    this.memory = memory;
    this.#vm = vm;
    this.#kind = kind;
    this.#dispatcher = new MappedDispatcher(this.#vm.code, compiler, imports);
  }

  get active(): boolean { return this.#active; }
  get heldInitial(): boolean { return this.#kind === 'held-initial'; }
  get firstEntryPending(): boolean { return this.#firstEntry !== undefined; }
  get pendingExit(): MappedExitRequest | undefined { return this.#pending; }
  syscallAt(pc: bigint): boolean { return this.#active && this.#dispatcher.syscallAt(pc); }
  reg(name: RegName): bigint { return this.#dispatcher.reg(name); }
  setReg(name: RegName, value: bigint): void { this.#dispatcher.setReg(name, value); }
  completeSyscall(pc: bigint, value: bigint): void { this.#dispatcher.completeSyscall(pc, value); }

  /** ARCH_GET_FS completes here. ARCH_SET_FS returns a checked candidate
   * to the owning syscall, without changing any active Wasm register. */
  fsSyscall(owner: Owner, op: bigint, address: bigint): bigint | undefined {
    if (!this.#active || this.heldInitial || this.#pending) throw new Error('No active mapped FS syscall owner');
    this.#vm.checkTaskOwner(owner);
    if (op === SET_FS) {
      // A segment base is not a dereference. Within this bounded address
      // profile it need not name a currently mapped page.
      if (address < 0n || address >= ADDRESS_LIMIT) throw new FsError(E.PERM);
      return address;
    }
    if (op === GET_FS) {
      if (address < 0n || address + 8n > ADDRESS_LIMIT) throw new FsError(E.FAULT);
      const word = new Uint8Array(8);
      new DataView(word.buffer).setBigUint64(0, this.reg('fs'), true);
      this.#vm.userMemory(owner).copyOut(Number(address), word);
      return undefined;
    }
    throw new FsError(E.INVAL);
  }

  completeFsSyscall(pc: bigint, base: bigint): never { return this.#dispatcher.completeFsSyscall(pc, base); }

  /** Failed preparation has not taken the memory or run an artifact. */
  discardPreparation(): void { this.#dispatcher.close(); this.#retired = true; }

  /** Transfer the publisher's original proof, not a new entry or generation. */
  armFirstEntry(check: (pc: bigint) => void): void {
    if (this.heldInitial || this.#active || this.#retiring || this.#retired || this.#firstEntry)
      throw new Error('Mapped Task cannot take an initial entry');
    this.#firstEntry = check;
  }

  run(pc: bigint, budget: number): void {
    if (this.heldInitial) throw new Error('Loader entry from a held initial Task is disabled');
    if (this.#active || this.#retiring || this.#retired) throw new Error('Mapped Task cannot run');
    this.#active = true;
    try {
      const first = this.#firstEntry;
      if (first) {
        try { first(pc); }
        catch (cause) {
          // This is not a guest wait, yield or resumed syscall.
          throw this.#pending ?? new Error('Mapped initial entry was not confirmed', {cause});
        }
        this.#firstEntry = undefined;
      }
      this.#dispatcher.run(pc, budget);
    }
    finally { this.#active = false; } // Every Wasm frame (including the import) has now unwound.
  }

  revoke(reason: object): void {
    this.#finishTidClear = undefined; // Failed ownership/retirement cannot publish an exit effect.
    this.#revokeAccess(reason);
  }

  #revokeAccess(reason: object): void {
    this.#firstEntry = undefined;
    this.#dispatcher.revoke(reason);
    this.#vm.close();
  }

  requestExit(status: number, owner: Owner, address: number): never {
    if (!this.#active) throw new Error('No mapped frame to unwind');
    if (this.#pending) throw this.#pending;
    this.#finishTidClear = this.#vm.prepareTidClear(owner, address);
    const request = this.#pending = new MappedExitRequest(status);
    this.#revokeAccess(request);
    throw request;
  }

  /** Retire CPU/VM ownership. Only the kernel may publish the returned exit effect. */
  retire(owner?: Owner, address = 0): (() => void) | undefined {
    if (this.#active || this.#retiring) throw new Error('Mapped Task has not unwound');
    if (this.#retired) return;
    this.#retiring = true;
    try {
      if (!this.#pending && owner) this.#finishTidClear = this.#vm.prepareTidClear(owner, address);
      this.#revokeAccess(this.#pending ?? new Error('Mapped Task retired'));
      const clear = this.#finishTidClear;
      this.#finishTidClear = undefined;
      this.#dispatcher.close();
      this.#retired = true;
      return clear;
    } finally { this.#retiring = false; }
  }
}
