/* Straight-line x86 block formation over the shared physical SSA. */

#ifndef POSTLINK_FORM_BLOCK_H
#define POSTLINK_FORM_BLOCK_H

#include "direct.h"
#include "instruction-semantics.h"

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
    /* Cost before cross-instruction composition and physical rewrites.  These
     * counters are diagnostic input to the native publication gate; they are
     * not retained in the emitted block identity. */
    pl_u32 source_work;
    pl_u32 source_span;
    pl_u32 instruction_count;
    pl_u32 successor_count;
    /* Complete-future equivalence relation used during native selection.
     * Dead coordinates are intentionally absent from semantic identity; this
     * mask is transient proof state and is never serialized in a block law. */
    pl_u32 live_output_mask;
    /* Derived from the decoded barrier, not another saved instruction table. */
    pl_u32 machine_inputs;
    pl_u8 kind;
    pl_u8 flow;
    pl_u8 dynamic_target;
    pl_u8 has_predicate;
    pl_u8 has_fault_predicate;
    pl_u8 trap_vector;
    pl_u8 machine_operation;
      /* Source construction records are not part of semantic identity.  This
       * provenance bit requests an exact source-field map; an unmatched field
       * is a publication error, never a reason to retain source spelling. */
    pl_u8 construction_fields;
    /* A linked consumer observes this finite source spelling as bytes in
     * addition to entering it as code.  Selection may rebind relocation
     * fields but may not substitute or erase any other source byte. */
    pl_u8 source_identity;
    /* Layout-selected canonical widening for a direct rel8 terminal.  This is
     * an emission choice, not part of the block's semantic identity. */
    pl_u8 relax_short_control;
    pl_u64 machine_argument;
} pl_x86_block;

/* Form the maximal pure run beginning at `start`.  A potentially faulting
 * instruction is isolated, and a machine barrier is never lowered as SSA.
 * Branch predicates and dynamic targets are kept live through composition and
 * compaction, so no intermediate architectural frame is materialized. */
int pl_x86_block_lower(const pl_x86_frontend *frontend, pl_u64 start,
                       const pl_x86_block_workspace *workspace,
                       pl_x86_block *out);

/* Form the same normalized block without beginning another instruction at or
 * beyond `exclusive_end`.  The first instruction may itself cross the cut:
 * x86 fetch is atomic at instruction granularity, so its complete bytes and
 * precise fault remain one compiler dependency. */
int pl_x86_block_lower_until(const pl_x86_frontend *frontend, pl_u64 start,
                             pl_u64 exclusive_end,
                             const pl_x86_block_workspace *workspace,
                             pl_x86_block *out);

/* Lower the same exact source cut while publishing only locals observed by
 * its complete future. Terminal predicates/targets, memory and traps remain
 * roots. The mask is over PL_X86_LOCAL_COUNT architectural coordinates. */
int pl_x86_block_lower_projected_until(
    const pl_x86_frontend *frontend, pl_u64 start, pl_u64 exclusive_end,
    pl_u32 live_output_mask, const pl_x86_block_workspace *workspace,
    pl_x86_block *out);

/* Re-form a suffix whose start was decoded as an instruction boundary of an
 * already-formed block.  Unlike an independently reachable Byte* coordinate,
 * it cannot inherit an interrupt shadow merely because the preceding ModRM
 * byte happens to equal the one-byte STI opcode. */
int pl_x86_block_lower_projected_suffix_until(
    const pl_x86_frontend *frontend, pl_u64 start, pl_u64 exclusive_end,
    pl_u32 live_output_mask, const pl_x86_block_workspace *workspace,
    pl_x86_block *out);

/* Backward preimage of a block's observed roots and selected output locals.
 * This is the transfer used by release-wide liveness. It returns a mask over
 * input architectural coordinates without retaining a dependency matrix. */
int pl_x86_block_live_inputs(const pl_x86_block *block,
                             pl_u32 live_output_mask,
                             pl_arena *arena, pl_u32 *input_mask);

/* Factor the backward transfer into its mandatory input and one dependency
 * mask per architectural output.  The transfer is distributive:
 * input(L) = mandatory U union(dependency[i], i in L). */
int pl_x86_block_live_transfer(
    const pl_x86_block *block, pl_arena *arena,
    pl_u32 *mandatory, pl_u32 dependency[PL_X86_LOCAL_COUNT]);

/* Bind already-closed static successor ranks to one direct block.
 * PL_X86_BLOCK_RESOLVE_RANK marks an arm that must enter the total page
 * dispatcher (including a target outside the linked executable image). */
int pl_x86_block_direct(const pl_x86_block *block,
                        const pl_u32 successor_rank[2],
                        pl_direct_block *out);

/* Lower a precise fault or typed machine barrier to the same direct function
 * ABI.  It is a terminal compiler result, not an execution fallback. */
int pl_x86_block_terminal_direct(const pl_x86_instruction *instruction,
                                 const pl_x86_block *block,
                                 pl_direct_block *out);

/* Collision-proved normalized block-function identities.  Representatives
 * are source coordinates rather than retained object graphs: a hash hit is
 * re-formed into the comparison workspace and the complete physical SSA plus
 * observable terminal is compared. */
typedef struct {
    pl_u64 hash;
    pl_u64 representative;
    /* The comparison cut lies in the representative's executable map.  Its
     * distance, not a second virtual address, is the independent fact. */
    pl_u32 limit_bytes;
    pl_u32 closed_successors;
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
    /* Zero for whole-image maximal formation.  A page projection sets this
     * to its exclusive end before admitting the first identity, so collision
     * proofs and erased-body regeneration replay the identical source cut. */
    pl_u64 formation_limit;
    /* First coordinate rejected by a form+intern replay.  Build tools expose
     * this diagnostic instead of collapsing a deterministic compiler failure
     * into an anonymous entry-map error. */
    pl_u64 failure_rip;
    int failure_status;
    /* A table may contain either closed block identities or immediate
     * observations, never a mixture of their equivalence relations. */
    pl_u8 identity_mode;
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
/* Intern only the immediate observable transfer.  Static successor
 * coordinates are deliberately excluded: their complete futures are
 * supplied to the finite-machine quotient after every reachable boundary
 * has been closed. */
int pl_x86_block_observation_intern(pl_x86_block_builder *builder,
                                    const pl_x86_block *block,
                                    pl_u32 closed_successors,
                                    pl_u32 *rank);

/* Canonical transient spelling of the exact immediate-observation relation
 * above.  In-image successor coordinates are omitted when their arm bit is
 * closed; non-image targets remain exact observable coordinates.  Image name,
 * block address, node ids and scheduling waves are absent. */
int pl_x86_block_observation_measure(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_u32 closed_successors, pl_u32 *bytes);
int pl_x86_block_observation_write(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_u32 closed_successors, pl_u8 *target, pl_u32 capacity,
    pl_u32 *written);

/* Canonical control shell used by the release-wide publisher.  The normalized
 * plan and terminal instruction transfer are deliberately absent: their
 * canonical ranks are substituted by the publisher.  Together with those
 * two ranks and the successor ranks, this spelling reconstructs exactly the
 * immediate observation above without storing its plan a second time. */
int pl_x86_block_control_measure(const pl_x86_block *block,
                                 pl_u32 closed_successors, pl_u32 *bytes);
int pl_x86_block_control_write(const pl_x86_block *block,
                               pl_u32 closed_successors,
                               pl_u8 *target, pl_u32 capacity,
                               pl_u32 *written);

/* Necessary-and-sufficient factorization of one immediate block response.
 * The law contains only the control kind, pure SSA topology and graph
 * references.  Constants, frame coordinates, machine arguments and external
 * successor addresses occur only in the binding row.  Concatenating the two
 * typed components is the exact immediate response; separating them lets the
 * release-wide Byte* quotient share a law across independently linked ELFs. */
int pl_x86_block_law_measure(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_u32 closed_successors, pl_u32 *bytes);
int pl_x86_block_law_write(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    pl_u32 closed_successors, pl_u8 *target, pl_u32 capacity,
    pl_u32 *written);
int pl_x86_block_bindings_measure(
    const pl_x86_block *block, pl_u32 closed_successors, pl_u32 *bytes);
int pl_x86_block_bindings_write(
    const pl_x86_block *block, pl_u32 closed_successors,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written);

/* Canonical instruction law after one-instruction physical-SSA lowering.
 * Lifted constants and source/link coordinates are bindings, so the law is
 * the control shell plus pure topology.  An anonymous barrier which the
 * semantic grammar cannot lower stays conservatively X86T1 and is explicitly
 * visible as such to the release gate. */
int pl_x86_instruction_law_measure(
    const pl_x86_frontend *frontend, pl_u64 rip,
    const pl_x86_block_workspace *workspace, pl_u32 *bytes);
int pl_x86_instruction_law_write(
    const pl_x86_frontend *frontend, pl_u64 rip,
    const pl_x86_block_workspace *workspace,
    pl_u8 *target, pl_u32 capacity, pl_u32 *written);
int pl_x86_block_rank_instruction(const pl_x86_instruction *instruction,
                                  void *context, pl_u32 *rank);

#endif /* POSTLINK_BLOCK_H */
