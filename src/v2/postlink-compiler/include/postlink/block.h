/* Straight-line x86 block formation over the shared physical SSA. */

#ifndef POSTLINK_BLOCK_H
#define POSTLINK_BLOCK_H

#include <postlink/semantic.h>
#include <postlink/wasm.h>

#define PL_ERROR_BLOCK       (-47)
#define PL_ERROR_BLOCK_LIMIT (-48)
#define PL_X86_BLOCK_RESOLVE_RANK 0xffffffffu

enum pl_x86_block_kind {
    PL_X86_BLOCK_DIRECT = 0,
    PL_X86_BLOCK_MACHINE_BARRIER = 1,
    PL_X86_BLOCK_FAULT = 2
};

/* Formation alternates between two caller-owned arenas.  The final plan
 * remains valid until either backing range is reused.  Alternation keeps the
 * workspace linear in the largest block instead of retaining every prefix. */
typedef struct {
    pl_u8 *first;
    pl_u8 *second;
    pl_u32 bytes_each;
    pl_u32 maximum_instructions;
} pl_x86_block_workspace;

typedef struct {
    pl_plan plan;
    pl_u64 start;
    pl_u64 end;
    pl_u64 successor[2];
    pl_operand target;
    pl_operand predicate;
    pl_operand fault_predicate;
    pl_operand machine_value;
    pl_u32 instruction_count;
    pl_u32 successor_count;
    pl_u8 kind;
    pl_u8 flow;
    pl_u8 dynamic_target;
    pl_u8 has_predicate;
    pl_u8 has_fault_predicate;
    pl_u8 trap_vector;
    pl_u8 machine_operation;
    pl_u8 reserved;
    pl_u64 machine_argument;
} pl_x86_block;

/* Form the maximal pure run beginning at `start`.  A potentially faulting
 * instruction is isolated, and a machine barrier is never lowered as SSA.
 * Branch predicates and dynamic targets are kept live through composition and
 * compaction, so no intermediate architectural frame is materialized. */
int pl_x86_block_lower(const pl_x86_frontend *frontend, pl_u64 start,
                       const pl_x86_block_workspace *workspace,
                       pl_x86_block *out);

/* Bind already-closed static successor ranks to one direct Wasm block.
 * PL_X86_BLOCK_RESOLVE_RANK marks an arm that must enter the total page
 * dispatcher (including a target outside the linked executable image). */
int pl_x86_block_wasm(const pl_x86_block *block,
                      const pl_u32 successor_rank[2],
                      pl_wasm_block *out);

/* Factor static control from executable code.  The emitted kernel publishes
 * the normalized architectural SSA and returns TRANSITION arm zero or one;
 * it contains neither successor ranks nor RIP deltas.  A dynamic target still
 * publishes RIP and returns RESOLVE_RIP. */
int pl_x86_block_kernel_wasm(const pl_x86_block *block, pl_wasm_block *out);

/* Collision-proved normalized block-function identities.  Representatives
 * are source coordinates rather than retained object graphs: a hash hit is
 * re-formed into the comparison workspace and the complete physical SSA plus
 * observable terminal is compared. */
typedef struct {
    pl_u64 hash;
    pl_u64 representative;
} pl_x86_block_identity;

typedef struct {
    pl_x86_frontend frontend;
    pl_x86_block_workspace formation;
    pl_x86_block_workspace comparison;
    pl_x86_block_identity *identities;
    pl_u32 identity_capacity;
    pl_u32 identity_count;
    pl_u32 *hash_slots;       /* identity rank + 1; zero means empty */
    pl_u32 hash_slot_count;
    pl_u64 admissions;
    pl_u64 shared;
    pl_u64 probes;
    pl_u32 maximum_probe;
} pl_x86_block_builder;

int pl_x86_block_builder_open(
    pl_x86_block_builder *builder, const pl_x86_image *image,
    const pl_x86_block_workspace *formation,
    const pl_x86_block_workspace *comparison,
    pl_x86_block_identity *identities, pl_u32 identity_capacity,
    pl_u32 *hash_slots, pl_u32 hash_slot_count);

/* Intern an already formed block or form+intern one closure coordinate. */
int pl_x86_block_intern(pl_x86_block_builder *builder,
                        const pl_x86_block *block, pl_u32 *rank);
int pl_x86_block_rank_instruction(const pl_x86_instruction *instruction,
                                  void *context, pl_u32 *rank);

#endif /* POSTLINK_BLOCK_H */
