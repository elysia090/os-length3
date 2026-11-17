/** Private non-owning lifecycle observations, not a reference-counting collector.
 * Existing runtime roots remain responsible for ownership. An empty snapshot is
 * never host-stop or collection proof; unknown observations survive freeze. */
export class WorkerLifetime {
  private frozen = false;
  private readonly owners = new Map<object, {kind: string; value?: WeakRef<object>}>();
  readonly failures: unknown[] = [];
  get accepting(): boolean { return !this.frozen; }
  check(): void { if (this.frozen) throw new Error('Worker is retiring; new work is not accepted'); }
  enter(kind: string): {release(): void} {
    this.check();
    return this.observe(kind);
  }
  /** Existing in-flight work may acquire its result after freeze. Record it,
   * then reject further publication; never silently lose that owner. */
  observe(kind: string, value?: object): {release(): void} {
    const key = {}; this.owners.set(key, {kind, value: value ? new WeakRef(value) : undefined});
    return {release: () => { this.owners.delete(key); }};
  }
  freeze(): void { this.frozen = true; }
  snapshot(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const {kind} of this.owners.values()) counts[kind] = (counts[kind] ?? 0) + 1;
    return counts;
  }
}
