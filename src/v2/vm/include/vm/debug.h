#ifndef VM_DEBUG_H
#define VM_DEBUG_H
#include <vm/registers.h>

/* Long-mode debug-register transfers. CR4.DE is absent in the fixed CPU
 * profile: DR4/5 alias DR6/7 without owning duplicate words. DR0..3 are
 * linear comparison values, not memory accesses or canonical-address checks.
 * The caller owns GPR/RIP/retirement publication and aborts on every failure.
 * GD sets DR6.BD and reports a pending #DB before the transfer; clearing GD
 * belongs to exception entry, not this API. Active address breakpoints still
 * refuse execution admission until their precise fault/trap boundary exists. */
machine_result vm_debug_transfer(vm_memory *physical, pl_u32 port_offset,
    machine_state *state, const machine_segments *segments,
    pl_u32 write, pl_u32 rank, pl_u64 value);
#endif
