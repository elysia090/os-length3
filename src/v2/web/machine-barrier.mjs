// ABI4: resource, quantum, clock, console and pending legacy FPU interrupt.
// A classified barrier is not an instruction retirement or a guest fault.
export function isMachineBarrier(result) {
  return typeof result==='bigint' && result>=2n && result<=34n && (result&7n)===2n;
}
