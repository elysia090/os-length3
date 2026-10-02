#ifndef VM_REGISTERS_H
#define VM_REGISTERS_H
#include <vm/segments.h>

/* Fixed machine CPU contract: 40 physical bits, no PCID/XSAVE/VMX/LA57.
 * CR4 exposes TSD, PSE, PAE, PGE, PCE, OSFXSR and OSXMMEXCPT. The check
 * derives this mask from the independently enumerated admission profile.
 * No decoder, source instruction or optimizer is needed by this boundary. */
#define VM_CPU_PHYSICAL_BITS 40u
#define VM_CPU_CR4_VISIBLE 0x7b4ull

/* Long-mode MOV to CR0/2/3/4/8. Validate before publishing any CPU change;
 * failures leave the state and hidden caches unchanged. Always abort an
 * outstanding memory reservation. Caller revokes executable admission on
 * success, including an equal-value CR3 write (architectural invalidation).
 * No TLB is retained by the current walker; adding one requires its flush
 * here. RIP/retirement are owned by the generated instruction, not this API. */
machine_result vm_control_write(vm_memory *physical, pl_u32 port_offset,
    machine_state *state, const machine_segments *segments, pl_u32 rank, pl_u64 value);
#endif
