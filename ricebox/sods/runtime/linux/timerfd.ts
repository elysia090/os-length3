// Timer state belongs to the open file description. The syscall layer supplies
// the guest's monotonic clock and its existing wait queue.
interface TimerBackend {
  now(): bigint;
  /** Schedule a later check at a guest monotonic deadline in ns and return its cancellation. */
  schedule(deadline: bigint, fire: () => void): () => void;
  /** Tell the wait queue that the descriptor has become readable. */
  notifyReady(): void;
}

const MAX_NS = (1n << 63n) - 1n;
export const capTimerTime = (ns: bigint): bigint => ns > MAX_NS ? MAX_NS : ns;

export class TimerFd {
  private next: bigint | null = null;
  private interval = 0n;
  private ticks = 0n;
  private expired = false;
  private cancelWake: (() => void) | null = null;
  changes = 0;

  private readonly backend: TimerBackend;

  constructor(backend: TimerBackend) { this.backend = backend; }

  private cancel(): void {
    this.cancelWake?.();
    this.cancelWake = null;
  }

  close(): void { this.cancel(); }

  private expire(): void {
    this.expired = true;
    this.ticks++;
    this.changes++;
    if (!this.interval) this.next = null;
    this.backend.notifyReady();
  }

  private arm(now: bigint): void {
    if (this.next === null) return;
    if (this.next <= now) { this.expire(); return; }
    this.cancelWake = this.backend.schedule(this.next, () => {
      this.cancelWake = null;
      this.arm(this.backend.now());
    });
  }

  private observe(now: bigint): void {
    // A syscall may see a due timer before the scheduler's next retry.
    if (this.cancelWake && this.next !== null && this.next <= now) {
      this.cancel();
      this.expire();
    }
  }

  private remaining(now: bigint): bigint {
    if (this.next === null) return 0n;
    if (this.next > now) return this.next - now;
    return this.interval ? this.interval - (now - this.next) % this.interval : 0n;
  }

  private forward(now: bigint): void {
    if (!this.expired) return;
    this.expired = false;
    if (this.next === null) return;
    // Keep a periodic timer's phase. An unread timer needs no further queue
    // entries: count the elapsed periods together when read or queried.
    const overrun = (now - this.next) / this.interval;
    this.ticks += overrun;
    this.next += (overrun + 1n) * this.interval;
    this.arm(now);
  }

  set(value: bigint, interval: bigint, absolute: boolean): [interval: bigint, remaining: bigint] {
    const now = this.backend.now(), old: [bigint, bigint] = [this.interval, this.remaining(now)];
    this.cancel();
    this.interval = interval;
    this.next = value ? capTimerTime(absolute ? value : now + value) : null;
    this.ticks = 0n;
    this.expired = false;
    this.arm(now);
    return old;
  }

  get(): [interval: bigint, remaining: bigint] {
    const now = this.backend.now();
    this.observe(now);
    this.forward(now);
    return [this.interval, this.remaining(now)];
  }

  ready(): boolean {
    this.observe(this.backend.now());
    return this.ticks > 0n;
  }

  read(): bigint {
    const now = this.backend.now();
    this.observe(now);
    this.forward(now);
    const ticks = this.ticks;
    this.ticks = 0n;
    return ticks;
  }
}
