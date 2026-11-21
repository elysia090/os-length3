/** Private non-owning lifecycle observations, not a reference-counting collector.
 * Existing runtime roots remain responsible for ownership. An empty snapshot is
 * never host-stop or collection proof; unknown observations survive freeze. */
export class WorkerLifetime {
  private frozen = false;
  private active = 0;
  private drained: Promise<void> | undefined;
  private resolveDrain: (() => void) | undefined;
  private readonly owners = new Map<object, {kind: string; value?: WeakRef<object>}>();
  readonly failures: unknown[] = [];
  get accepting(): boolean { return !this.frozen; }
  check(): void { if (this.frozen) throw new Error('Worker is retiring; new work is not accepted'); }
  enter(kind: string): {release(): void} {
    this.check();
    const observation = this.observe(kind);
    this.active++;
    let released = false;
    return {release: () => {
      if (released) return;
      released = true;
      observation.release();
      this.active--;
      if (this.frozen && this.active === 0) { this.resolveDrain?.(); this.resolveDrain = undefined; }
    }};
  }
  /** Existing in-flight work may acquire its result after freeze. Record it,
   * then reject further publication; never silently lose that owner. */
  observe(kind: string, value?: object): {release(): void} {
    const key = {}; this.owners.set(key, {kind, value: value ? new WeakRef(value) : undefined});
    return {release: () => { this.owners.delete(key); }};
  }
  freeze(): void { this.frozen = true; }
  /** Only registered enter/finally operations, NOT unknown observations, host
   * callbacks, successful cleanup or stopped CPU Workers. Call after issuing
   * halt/close: waiting for a serve operation before requesting stop can deadlock. */
  settledOperations(): Promise<void> {
    if (!this.frozen) throw new Error('Operation drain requires admission closure');
    return this.drained ??= this.active === 0 ? Promise.resolve() : new Promise(resolve => { this.resolveDrain = resolve; });
  }
  snapshot(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const {kind} of this.owners.values()) counts[kind] = (counts[kind] ?? 0) + 1;
    return counts;
  }
}
