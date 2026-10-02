#ifndef VM_TABLES_H
#define VM_TABLES_H
#include <vm/mmu.h>
#include <machine/state.h>

/* Long-mode GDTR/IDTR transfer, rank 0/1; no instruction decoder or opcode.
 * CPU tables commit together after a complete ten-byte MMU preflight/read.
 * The caller supplies a valid, disjoint state and private port reservation. */
machine_result vm_table_load(vm_memory *physical, pl_u32 port_offset,
                              machine_state *state, pl_u64 address,
                              pl_u32 rank, pl_u32 access);
#endif
