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

typedef struct {
    pl_u64 address, generation;
    pl_u32 offset, bytes;
} vm_code_page;

/* The directory describes resident PHYSICAL pages, not guest translations.
 * All context/rows/residency are pinned by a serialized single-vCPU owner.
 * A table or data cache miss requests physical admission; it is never #PF.
 * CPU faults leave payload/CPU state unchanged, but a page walk can set A/D
 * in paging structures, including ancestors preceding a later fault. This
 * observable architectural side effect must not be rolled back as host I/O.
 * LA57, PCID, SMEP/SMAP, protection keys, 1 GiB pages and non-long-mode are
 * deliberately not accepted. Unsupported CPU context returns ENTRY_MAP,
 * rather than silently translating with fewer permissions. Fault delivery
 * and CR2 publication use the separate exception boundary (currently only
 * CPL0, long-mode, IST=0). General IRQ/TSS/IST/double-fault handling and a
 * retained architectural TLB remain separate work. */
machine_result vm_mmu_access(vm_memory *physical, pl_u32 port_offset,
                             const vm_mmu_context *context, pl_u64 address,
                             pl_u32 bytes, pl_u32 access, pl_u64 value);
/* Read with write-intent translation, preserving #PF W/R and exact physical
 * destinations until commit. access must be READ|WRITE, optionally STACK. */
machine_result vm_mmu_reserve(vm_memory *physical, pl_u32 port_offset,
                              const vm_mmu_context *context, pl_u64 address,
                              pl_u32 bytes, pl_u32 access);
/* Privileged C caller only: target is a disjoint private buffer of bytes
 * (1..16), never a guest/state/directory pointer. Not a generated-code import. */
machine_result vm_mmu_read_record(vm_memory *physical, pl_u32 port_offset,
                                  const vm_mmu_context *context, pl_u64 address,
                                  pl_u32 bytes, pl_u32 access, pl_u8 *target);
/* Privileged, borrowed executable page, not a generated-code import.
 * Translate the exact requested RIP (including its precise fetch fault),
 * then expose its resident 4 KiB fragment without copying payload. offset
 * is relative to physical->bytes, NEVER the guest virtual address. The
 * serialized owner pins context, bytes and directory through compilation
 * and execution admission. Any intervening mutation requires a fresh view.
 * target is disjoint private caller memory; it is unchanged on failure. */
machine_result vm_mmu_code_page(vm_memory *physical, pl_u32 port_offset,
                                const vm_mmu_context *context, pl_u64 address,
                                vm_code_page *target);
#endif
