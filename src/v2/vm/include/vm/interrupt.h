#ifndef VM_INTERRUPT_H
#define VM_INTERRUPT_H
#include <vm/segments.h>
/* Architectural IF transfer, not an opcode decoder. Compiled CLI/STI supply
 * only the desired bit. C owns privilege and boundary inhibition; generated
 * code still owns successful RF clearing, RIP and instruction retirement. */
machine_result vm_interrupt_flag(vm_memory *memory, pl_u32 port,
    machine_state *state, machine_segments *segments, pl_u32 enable);
#endif
