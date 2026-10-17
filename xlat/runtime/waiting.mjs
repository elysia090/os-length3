// What the worker says after the kernel ran as far as it could (Kernel.pump):
// it ended, or it waits, and for what. A kernel waits for 'input' (what runs
// reads what is typed, and nothing goes on until it comes) or for 'time' (a
// process sleeps, and goes on by itself in `ms` milliseconds, input or not),
// so the page says "waiting for input" only when input is what it needs.

/** The message for pump result `r`, with what the kernel holds (Kernel.held) and the time now (performance.now()). */
export function said(r, held, now) {
  if (!r.waiting) return {type: 'exit', status: r.status, memory: 0};
  if (r.until === undefined) return {type: 'waiting', for: 'input', memory: held.total, held};
  return {type: 'waiting', for: 'time', ms: Math.max(0, r.until - now), memory: held.total, held};
}
