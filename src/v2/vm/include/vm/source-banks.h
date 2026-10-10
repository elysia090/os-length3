#ifndef VM_SOURCE_BANKS_H
#define VM_SOURCE_BANKS_H
#include <vm/source.h>
#define VM_SOURCE_BANKS 128u
#define VM_SOURCE_GROUPS (VM_SOURCE_BANKS / 32u)
#define VM_SOURCE_CAPACITY (VM_SOURCE_BANKS * VM_SOURCE_ROWS)
typedef struct {
    vm_sources banks[VM_SOURCE_BANKS];
    pl_u32 watch[VM_SOURCE_GROUPS][VM_SOURCE_WATCH_BUCKETS], active;
    pl_u64 revoked, cancelled;
} vm_source_banks;
/* Rank sets remain one machine word. A coordinate chooses one bounded owner;
 * executable MMU/source admission is unchanged. Watch masks are conservative
 * bank candidates, never permission or source identity. No payload is copied. */
void vm_source_banks_open(vm_source_banks *owner,pl_u64 generation,pl_u32 first_slot);
vm_sources *vm_source_banks_select(vm_source_banks *owner,pl_u64 entry,pl_u32 physical_offset);
int vm_source_banks_empty(const vm_source_banks *owner);
void vm_source_banks_published(vm_source_banks *owner);
void vm_source_banks_write(void *owner,pl_u32 offset,pl_u32 bytes);
#endif
