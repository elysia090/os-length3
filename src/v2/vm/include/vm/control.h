#ifndef VM_CONTROL_H
#define VM_CONTROL_H
#include <vm/segments.h>
#include <vm/exception.h>
/* 16/32/64-bit far return, same/outer privilege to 64-bit code. Return word
 * is defined in machine/control.h; compatibility/CET remain explicit gaps.
 * No RIP/CS/cache/RSP publication before the complete stack/descriptor check. */
machine_result vm_far_return(vm_memory *physical, pl_u32 port_offset,
                              machine_state *state, machine_segments *segments,
                              pl_u32 return_word);
/* One existing bounded event frontier. Descriptor/stack effects are ordered
 * and retained across residency; no guest opcode or full CPU image is read. */
machine_result vm_far_transfer(vm_memory *physical,pl_u32 port_offset,machine_state *state,
    machine_segments *segments,vm_fault_delivery *frontier,pl_u32 word,
    pl_u64 target,pl_u32 selector,pl_u64 next_rip);
#endif
