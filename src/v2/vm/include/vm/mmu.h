/* Four-level long-mode translation for the fixed 40-bit physical CPU profile. */
#ifndef VM_MMU_H
#define VM_MMU_H
#include <vm/memory.h>

enum vm_mmu_access {
    VM_MMU_EXECUTE = 8u,
    VM_MMU_PHYSICAL_REQUEST = 16u,
    VM_MMU_ALIGNED16 = MACHINE_MEMORY_ALIGNED16,
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
/* In particular INVLPG targets the empty translation-cache set in this ABI.
 * Compiled entry fetch and every payload access must walk current tables,
 * including PGE/global and large-page cases. A future retained TLB or walk
 * cache must change the compiler's invalidation lowering together with this
 * contract; the physical-owner/source-module caches are not substitutes. */
machine_result vm_mmu_access(vm_memory *physical, pl_u32 port_offset,
                             const vm_mmu_context *context, pl_u64 address,
                             pl_u32 bytes, pl_u32 access, pl_u64 value);
/* Read with write-intent translation, preserving #PF W/R and exact physical
 * destinations until commit. access must be READ|WRITE, optionally STACK. */
machine_result vm_mmu_reserve(vm_memory *physical, pl_u32 port_offset,
                              const vm_mmu_context *context, pl_u64 address,
                              pl_u32 bytes, pl_u32 access);
/* Bounded record RMW for implicit system descriptors: all fragments obtain
 * read/write rights before target is filled or a reservation is published.
 * Private target is disjoint from guest/state/directory. No SMP claim. */
machine_result vm_mmu_reserve_record(vm_memory *physical, pl_u32 port_offset,
                                     const vm_mmu_context *context, pl_u64 address,
                                     pl_u32 bytes, pl_u8 *target);
/* Same bounded private record, with READ|WRITE[|STACK|ALIGNED16]. Alignment
 * faults precede page translation; ALIGNED16 is valid only for a 16-byte
 * record. The byte-range canonicality check retains #SS for stack operands. */
machine_result vm_mmu_reserve_record_access(vm_memory *physical, pl_u32 port_offset,
                                            const vm_mmu_context *context, pl_u64 address,
                                            pl_u32 bytes, pl_u32 access, pl_u8 *target);
/* Privileged C caller only: target is a disjoint private buffer of bytes
 * (1..16), never a guest/state/directory pointer. READ[|STACK|ALIGNED16];
 * ALIGNED16 requires exactly 16 bytes. The C read_pair adapter publishes
 * the two private words only after success; no output survives fault/wait. */
machine_result vm_mmu_read_record(vm_memory *physical, pl_u32 port_offset,
                                  const vm_mmu_context *context, pl_u64 address,
                                  pl_u32 bytes, pl_u32 access, pl_u8 *target);
/* Same preflight for exactly sixteen bytes: substitute pinned fragments into
 * pair-port value/high directly. No record buffer or RMW reservation; the
 * pair extent must be private/reserved and disjoint from CPU/directory. */
machine_result vm_mmu_read_pair(vm_memory *physical, pl_u32 port_offset,
                                const vm_mmu_context *context, pl_u64 address,
                                pl_u32 bytes, pl_u32 access);
/* READ[|STACK|ALIGNED16] over 1..512 bytes. Publish only physical coordinates,
 * never a record copy. Borrowed view has the same synchronous lifetime as pair
 * reads; generated consumers do not call another provider before finishing. */
machine_result vm_mmu_read_extent(vm_memory *physical, pl_u32 port_offset,
                                  const vm_mmu_context *context, pl_u64 address,
                                  pl_u32 bytes, pl_u32 access);
/* Preflight WRITE[|STACK|ALIGNED16] over 1..512 bytes, pin at most two
 * physical fragments, without reading or copying payload. Canonical range,
 * alignment and all page permissions precede the first output store.
 * Paging A/D updates remain observable even on failure. The same serialized
 * owner is held until write_end/abort; no yield or remap is permitted. */
machine_result vm_mmu_write_begin(vm_memory *physical, pl_u32 port_offset,
                                  const vm_mmu_context *context, pl_u64 address,
                                  pl_u32 bytes, pl_u32 access);
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
