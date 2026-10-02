/* Four-level long-mode translation for the fixed 40-bit physical CPU profile. */
#ifndef VM_MMU_H
#define VM_MMU_H
#include <vm/memory.h>

enum vm_mmu_access {
    VM_MMU_EXECUTE = 8u,
    VM_MMU_PHYSICAL_REQUEST = 16u,
};
typedef struct {
    pl_u64 cr0, cr3, cr4, efer;
    pl_u32 cpl;
} vm_mmu_context;

/* The directory describes resident PHYSICAL pages, not guest translations.
 * All context/rows/residency are pinned by a serialized single-vCPU owner.
 * A table or data cache miss requests physical admission; it is never #PF.
 * CPU faults leave payload/CPU state unchanged, but a page walk can set A/D
 * in paging structures, including ancestors preceding a later fault. This
 * observable architectural side effect must not be rolled back as host I/O.
 * LA57, PCID, SMEP/SMAP, protection keys, 1 GiB pages and non-long-mode are
 * deliberately not accepted. Unsupported CPU context returns ENTRY_MAP,
 * rather than silently translating with fewer permissions. Fault delivery,
 * CR2 publication, TLB invalidation and interrupt entry are separate work. */
machine_result vm_mmu_access(vm_memory *physical, pl_u32 port_offset,
                             const vm_mmu_context *context, pl_u64 address,
                             pl_u32 bytes, pl_u32 access, pl_u64 value);
#endif
