/* Architectural segment caches, separate from the frozen register-cut ABI. */
#ifndef MACHINE_SEGMENTS_H
#define MACHINE_SEGMENTS_H
#include <support/types.h>

#define MACHINE_SEGMENTS_ABI_VERSION 2u
#define MACHINE_SEGMENT_COUNT 8u
enum machine_segment_rank {
    MACHINE_SEGMENT_ES, MACHINE_SEGMENT_CS, MACHINE_SEGMENT_SS,
    MACHINE_SEGMENT_DS, MACHINE_SEGMENT_FS, MACHINE_SEGMENT_GS,
    MACHINE_SEGMENT_LDTR, MACHINE_SEGMENT_TR,
};
#define MACHINE_SEGMENT_UNUSABLE 0x10000u
/* Mutually exclusive boundary inhibition, not two independent countdowns.
 * STI blocks maskable interrupts; MOV SS also inhibits ordinary debug
 * conditions. Explicit INT1 traps are not blocked by either kind.
 * Exact suspend retains the kind, and admission rejects unknown kinds. */
enum { MACHINE_SHADOW_NONE, MACHINE_SHADOW_MOV_SS, MACHINE_SHADOW_STI };

/* Attributes use the access byte in bits 0..7 and AVL/L/D/G in 12..15.
 * Selectors remain in machine_state.system; FS/GS base lives here, not in
 * a duplicate MSR-list entry. Exact suspend retains both architectural cuts.
 * Descriptor-table edits do not implicitly refresh these hidden caches. */
typedef struct {
    pl_u64 base;
    pl_u32 limit;
    pl_u32 attributes;
} machine_segment_cache;
typedef struct {
    pl_u32 version;
    pl_u32 interrupt_shadow;
    machine_segment_cache cache[MACHINE_SEGMENT_COUNT];
} machine_segments;
_Static_assert(sizeof(machine_segments) == 136u, "segment context ABI extent");

/* Compiled selector loads import machine.segment:
 * (i32 private_port, i32 segment_rank, i32 selector) -> i64 result.
 * DIRECT/0 commits selector/cache only; generated code retires the transfer.
 * A fault/cache miss leaves selector/cache and retirement unchanged. Paging
 * A/D and successful descriptor Accessed/busy updates are guest RAM writes.
 * Memory-source system loads read through machine.access first; no source
 * opcode or EA decoder is added to the segment owner. LDTR/TR require CPL0.
 * No source opcode, register number or instruction decoder is passed here. */
/* machine.descriptor(private_pair_port,selector16) -> result borrows exactly
 * the current raw8-byte GDT/LDT row. DIRECT supplies raw value + availability
 * in scalar.value/high; a missing coordinate is 0/0. Typed interpretation
 * and visible flag/register publication belong to the compiled transfer.
 * Implicit reads use supervisor privilege. Fault/wait leaves both outputs;
 * no opcode, destination coordinate or full CPU image crosses this API. */
#endif
