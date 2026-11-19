// Guest monotonic timer descriptors use the same clock and wait queue as the
// syscall dispatcher. No host fd, independent timer loop or device is needed.
import {steady} from '../host.ts';
import {clocks} from './clock.ts';
import type {Kern, Timer} from './parts.ts';

const {monotonic} = clocks();
const MAX_NS = (1n << 63n) - 1n;
export const capTimerTime = (ns: bigint): bigint => ns > MAX_NS ? MAX_NS : ns;

export class TimerFd {
  private next: bigint | null = null;
  private interval = 0n;
  private ticks = 0n;
  private expired = false;
  private scheduled: Timer | null = null;
  changes = 0;

  private readonly kernel: Kern;

  constructor(kernel: Kern) { this.kernel = kernel; }

  private cancel(): void {
    if (this.scheduled) this.kernel.removeTimer(this.scheduled);
    this.scheduled = null;
  }

  close(): void { this.cancel(); }

  private expire(): void {
    this.expired = true;
    this.ticks++;
    this.changes++;
    if (!this.interval) this.next = null;
    this.kernel.dirty = true;
  }

  private arm(now: bigint): void {
    if (this.next === null) return;
    if (this.next <= now) { this.expire(); return; }
    // The shared monotonic clock has the queue's origin, but can be rounded
    // differently. Recheck it at delivery, without requeueing at the same time.
    const host = steady();
    // Stay below the inline browser runner's maximum setTimeout delay.
    const at = Math.min(host + 0x7fffffff, Math.max(Number(this.next) / 1e6, host + 0.001));
    this.scheduled = this.kernel.addTimer(at, () => { this.scheduled = null; this.arm(monotonic()); });
  }

  private observe(now: bigint): void {
    // A syscall may see a due timer before the scheduler's next retry.
    if (this.scheduled && this.next !== null && this.next <= now) {
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
    const now = monotonic(), old: [bigint, bigint] = [this.interval, this.remaining(now)];
    this.cancel();
    this.interval = interval;
    this.next = value ? capTimerTime(absolute ? value : now + value) : null;
    this.ticks = 0n;
    this.expired = false;
    this.arm(now);
    return old;
  }

  get(): [interval: bigint, remaining: bigint] {
    const now = monotonic();
    this.observe(now);
    this.forward(now);
    return [this.interval, this.remaining(now)];
  }

  ready(): boolean {
    this.observe(monotonic());
    return this.ticks > 0n;
  }

  read(): bigint {
    const now = monotonic();
    this.observe(now);
    this.forward(now);
    const ticks = this.ticks;
    this.ticks = 0n;
    return ticks;
  }
}
