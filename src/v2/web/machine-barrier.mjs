// ABI4: resource, quantum, clock, console, FPU, network and block transfer.
// A classified barrier is not an instruction retirement or a guest fault.
export function isMachineBarrier(result) {
  return typeof result==='bigint' && result>=2n && result<=50n && (result&7n)===2n;
}
