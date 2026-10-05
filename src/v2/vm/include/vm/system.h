#ifndef VM_SYSTEM_H
#define VM_SYSTEM_H
#include <vm/msr.h>
#include <machine/system.h>
/* Intel 48-bit long-mode, valid fixed MSR bank, CET/TF disabled. CALL64 uses
 * STAR/LSTAR/FMASK without descriptor/TSS/stack access. RETURN64 checks CPL0
 * and canonical RCX before any CPU/cache publication. Disabled SCE produces
 * #UD; unsupported projection states explicitly refuse admission.
 * RSP, other GPRs, data/FS/GS caches and guest RAM are unchanged. No allocation,
 * CPU snapshot, syscall implementation or instruction decoder belongs here.
 * Abort outstanding physical reservations even on stale/refused requests. */
machine_result vm_system_transfer(vm_memory *physical, pl_u32 port_offset,
    machine_state *state, machine_segments *segments, pl_u32 operation, pl_u64 next_rip);
#endif
