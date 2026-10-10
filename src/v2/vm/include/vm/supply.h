/* Initial physical-page admission for a serialized, pinned boot owner. */
#ifndef VM_SUPPLY_H
#define VM_SUPPLY_H
#include <vm/boot.h>
#include <vm/memory.h>

enum { VM_SUPPLY_SOURCE_UNMAPPED = -4 };

typedef struct {
    pl_u64 generation, address, source_offset;
    pl_u32 target_offset, source_bytes, source_kind, rights;
    pl_u64 ticket;
} vm_page_request;
_Static_assert(sizeof(vm_page_request) == 48u, "page request transport extent");

typedef struct {
    pl_u64 sequence, context[6];
    pl_u32 port, bytes, access;
    pl_u64 address, generation;
    vm_page_request prepared;
} vm_page_supply;

/* Reset admission, not the non-wrapping per-instance ticket sequence.
 * Fresh Workers still require the supervisor's distinct incarnation. */
void vm_supply_reset(vm_page_supply *supply);
void vm_supply_capture(vm_page_supply *supply, const vm_memory *memory,
                        const machine_state *state, pl_u32 port, machine_result result);
/* The boot plan projects INITIAL bytes only. A resident row, including a
 * deferred/fault row, cannot be replaced. No eviction is allowed by this API.
 * Source extents must be authenticated by Artifact/Storage before commit;
 * this lifecycle gate is not a digest, AEAD, dirty-state or SMP proof.
 * Returns -2 for descriptor capacity, -3 for payload extent, -4 for a valid
 * physical request outside the initial boot source map, -1 for invalid/stale
 * input. -4 never publishes bytes/a ticket or manufactures a guest fault;
 * firmware/device admission is a separate machine contract, not zero RAM. */
int vm_supply_prepare(vm_page_supply *supply, vm_memory *memory, vm_boot *boot,
                       const machine_state *state, pl_u32 port, vm_page_request *request);
int vm_supply_commit(vm_page_supply *supply, vm_memory *memory,
                      const machine_state *state, pl_u32 port, pl_u64 ticket);
#endif
