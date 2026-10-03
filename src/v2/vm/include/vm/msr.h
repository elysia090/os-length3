#ifndef VM_MSR_H
#define VM_MSR_H
#include <vm/registers.h>
#include <machine/msr.h>

/* CPL0, 48-bit canonical addresses, EFER SCE/LME/LMA/NXE. LMA is read-only
 * (writes ignored); LME cannot change while paging is enabled. Unavailable
 * keys and reserved values fault before any publication. Advertised TSC
 * remains an admission refusal, not an invented #GP. STAR low 32 and FMASK
 * high 32 are reserved; LSTAR is canonical, unused Intel CSTAR is not
 * dereferenced. Their declared initial values are zero.
 * MISC_ENABLE and CPUID share the fixed six-rank residual bank. Its status
 * and active-NXE write restrictions are explicit admission boundaries.
 * No guest RAM walk,
 * time/device emulation or opcode decoder belongs to this register boundary.
 * Abort every outstanding reservation, including on refusal or stale input. */
machine_result vm_msr_transfer(vm_memory *physical, pl_u32 port_offset,
    machine_state *state, machine_segments *segments,
    pl_u32 operation, pl_u32 key, pl_u64 value);
#endif
