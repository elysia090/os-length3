#ifndef VM_CONTROL_H
#define VM_CONTROL_H
#include <vm/segments.h>
/* 64-bit far return to the same privilege and 64-bit code mode. Outer-level
 * returns, compatibility targets and CET remain explicit admission failures.
 * No RIP/CS/cache/RSP publication before the complete stack/descriptor check. */
machine_result vm_far_return(vm_memory *physical, pl_u32 port_offset,
                              machine_state *state, machine_segments *segments,
                              pl_u32 discard_bytes);
#endif
