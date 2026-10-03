#ifndef VM_TABLES_H
#define VM_TABLES_H
#include <vm/mmu.h>
#include <machine/state.h>

/* The two-store frontier is not a CPU snapshot. A completed two-byte limit
 * store must not be repeated after a residency wait: it can alias code or
 * paging structures. Generation, port, address and architectural inputs bind
 * the in-flight transfer; close/rebind must clear it. */
typedef struct {
    pl_u64 generation, address, context[7], base, limit;
    pl_u32 port, rank, access, stage;
} vm_table_frontier;
_Static_assert(sizeof(vm_table_frontier)==104u,"bounded descriptor-store frontier");

/* Long-mode GDTR/IDTR transfer, rank 0/1, READ or WRITE, optionally STACK.
 * Loads commit CPU tables only after the complete ten-byte read. Stores
 * perform the two-byte limit then the eight-byte base: a later guest fault
 * retains the completed payload store, but publishes no CPU/retirement.
 * A host residency wait retains the exact next-store frontier instead.
 * The caller supplies a valid, disjoint state/frontier and private port;
 * pin the compiled instruction and serialize all writers across a wait.
 * This is not an atomic ten-byte/SMP store, decoder or opcode callback. */
machine_result vm_table_transfer(vm_memory *physical, pl_u32 port_offset,
    machine_state *state, vm_table_frontier *frontier, pl_u64 address,
    pl_u32 rank, pl_u32 access);
#endif
