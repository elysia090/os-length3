/* Native x86 instruction selection from one normalized source block. */

#ifndef POSTLINK_SELECT_X86_H
#define POSTLINK_SELECT_X86_H

#include "block.h"

#define PL_ERROR_X86_SELECT (-49)
#define PL_ERROR_X86_PARETO (-50)
#define PL_X86_NATIVE_MAX_FIXUPS 64u
#define PL_X86_VALUE_ALIAS_COUNT 160u
/* Eighteen proved normalized grammar productions plus the exact linked-source
 * spelling.  The selector must expose every matching production: stopping at
 * the first match can hide an independently minimal work or span witness. */
#define PL_X86_NATIVE_MAX_CANDIDATES 19u

enum pl_x86_native_fixup {
    PL_X86_NATIVE_FIXUP_NONE = 0,
    PL_X86_NATIVE_FIXUP_PC_RELATIVE = 1,
    PL_X86_NATIVE_FIXUP_RIP_DISPLACEMENT = 2,
    PL_X86_NATIVE_FIXUP_ABSOLUTE = 3,
};

enum pl_x86_native_select_reason {
    PL_X86_NATIVE_SELECT_READY = 0,
    PL_X86_NATIVE_SELECT_STATEFUL = 1,
    PL_X86_NATIVE_SELECT_POSITION = 2,
    PL_X86_NATIVE_SELECT_CONTROL = 3,
};

typedef struct {
    pl_u32 at;
    /* Offset of the architectural next RIP from the beginning of output. */
    pl_u32 next_ip_at;
    pl_u64 target;
    /* A synthesized field may replace one exact linked-x86 construction
     * field.  `source_at` is relative to the normalized block start, so this
     * binding is independent of both the input and output load address.  A
     * zero source_bytes denotes a fixup which has no construction-field
     * owner (for example a synthesized bridge). */
    pl_u32 source_at;
    pl_u8 kind;
    pl_u8 bytes;
    pl_u8 source_bytes;
    pl_u8 reserved[1];
} pl_x86_native_fixup;

typedef struct {
    pl_u32 source_bytes;
    pl_u32 output_bytes;
    pl_u32 eliminated_bytes;
    pl_u32 output_instructions;
    /* Exact work of the selected x86 grammar body and a proved dependency
     * upper bound for one execution of it.  Static body instruction count is
     * kept separately because mutually independent register publications form
     * one wave even though ordinary x86 spells them as several instructions. */
    pl_u32 output_work;
    pl_u32 output_span;
    pl_u32 blocking_opcode;
    pl_u32 blocking_work;
    pl_u32 fixup_count;
    pl_u32 omitted_prefix_bytes;
    /* One entry-generation subtree may be seeded into its final root before
     * a same-coordinate new generation is published.  These fields are
     * transient instruction-selection state; optimized ELF stores only the
     * emitted ordinary x86 bytes. */
    pl_u64 frame_alias_value;
    /* Instructions retained by the backward complete-future projection.
     * This is transient compiler workspace, never an optimized-ELF row. */
    pl_u64 projected_instruction_mask;
    /* Final GPR publications for which direct construction proved strictly
     * less work than constructing on an entry owner and copying back.  The
     * mask is transient replay state for the measure/write pair. */
    pl_u32 frame_direct_destination_mask;
    pl_x86_native_fixup fixups[PL_X86_NATIVE_MAX_FIXUPS];
    pl_u8 supported;
    pl_u8 copied_source;
    pl_u8 direct_frame;
    pl_u8 direct_add_frame;
    pl_u8 direct_alu_frame;
    pl_u8 direct_insert_frame;
    pl_u8 reason;
    pl_u8 direct_compare_frame;
    pl_u8 direct_common_frame;
    pl_u8 direct_shift_frame;
    pl_u8 direct_branch_frame;
    pl_u8 direct_entry_branch_frame;
    pl_u8 direct_arx_frame;
    pl_u8 direct_mutable_xor_frame;
    pl_u8 direct_shared_owner_frame;
    pl_u8 direct_shared_parent_frame;
    pl_u8 direct_transient_owner_frame;
    pl_u8 direct_zero_flag_frame;
    pl_u8 direct_shift_handoff_frame;
    pl_u8 direct_affine_frame;
    pl_u8 direct_mul_add_carry_frame;
    pl_u8 direct_condition_carry_frame;
    pl_u8 direct_value_predicate_frame;
    pl_u8 direct_compare_handoff_frame;
    pl_u8 direct_live_frame;
    pl_u8 direct_shared_dag_frame;
    pl_u8 direct_consumed_flag_frame;
    pl_u8 direct_transient_seed_frame;
    pl_u8 direct_nested_frame;
    pl_u8 frame_anchor;
    pl_u8 frame_alias_kind;
    pl_u8 frame_alias_local;
    pl_u8 frame_alias_present;
    /* The alias a frame's publication loop starts from.  measure and write must
     * resolve `physicalize_transient_operand` from the same state, so the write
     * path restores this starting alias instead of inheriting whichever alias
     * the last measured publication happened to leave in `frame_alias_*`. */
    pl_u8 frame_alias_frame_kind;
    pl_u8 frame_alias_frame_local;
    pl_u8 frame_alias_frame_present;
    /* A shared-DAG schedule keeps an intermediate SSA node or a spilled entry
     * generation in a chosen output register across the whole frame, so
     * operand resolution must see that physical coordinate instead of a plan
     * local.  Transient instruction-selection workspace. */
    pl_u64 value_alias_value[PL_X86_VALUE_ALIAS_COUNT];
    pl_u8 value_alias_kind[PL_X86_VALUE_ALIAS_COUNT];
    pl_u8 value_alias_local[PL_X86_VALUE_ALIAS_COUNT];
    pl_u8 value_alias_count;
    /* At least one exact normalized-x86 grammar production covers this
     * semantic block.  A copied source spelling may still win bytes after it
     * independently attains work* and span*; that is not a normalization
     * escape. */
    pl_u8 normalized_family_present;
} pl_x86_native_selection;

/* All currently proved ordinary-x86 spellings for one normalized block.
 * Keeping the alternatives visible is necessary for whole-ELF selection: a
 * locally longer spelling can remain below the release-wide span/work maxima
 * and remove more global layout bytes. */
typedef struct {
    pl_x86_native_selection candidate[PL_X86_NATIVE_MAX_CANDIDATES];
    pl_x86_native_selection diagnostic;
    pl_u32 count;
    /* Nonzero only when candidate construction itself fails.  The high byte
     * identifies grammar, suffix, source-copy or cost derivation and the low
     * byte identifies the production/candidate.  This is transient compiler
     * diagnostics and is never part of an optimized ELF or its proof. */
    pl_u32 diagnostic_stage;
} pl_x86_native_candidates;

typedef struct {
    pl_u32 changed;
    pl_u32 final_flag_node;
    pl_u32 final_flag_owner;
    pl_u32 standalone_flag_dependencies;
    pl_u32 sources[PL_X86_GPR_COUNT];
    pl_u32 dependencies[PL_X86_GPR_COUNT];
} pl_x86_alu_schedule_diagnostic;

/* Check-only view of the exact scheduling law used by the dense ALU grammar.
 * It exposes no runtime state and is never serialized into optimized ELF. */
int pl_x86_select_alu_schedule_diagnostic(
    const pl_x86_block *block, pl_x86_alu_schedule_diagnostic *out);

int pl_x86_select_candidates(const pl_x86_frontend *frontend,
                             const pl_x86_block_workspace *workspace,
                             const pl_x86_block *block,
                             pl_x86_native_candidates *out);

/* Componentwise costs are properties of one semantic candidate family, not
 * slack that another block may lend it.  Compute span* and work* independently
 * and publish only a member attaining both.  If the two minima have no joint
 * witness the family remains an unresolved Pareto frontier and selection
 * fails. `serial_work/span` charges an unavoidable bridge or event frame
 * attached to every candidate in the family.  Pass a maximum span ceiling to
 * minimum_work when computing the independent work minimum; a narrower
 * ceiling intentionally asks a conditional query. */
int pl_x86_candidates_minimum_span(
    const pl_x86_native_candidates *candidates, pl_u32 serial_span,
    pl_u32 *out);
int pl_x86_candidates_minimum_work(
    const pl_x86_native_candidates *candidates,
    pl_u32 serial_span, pl_u32 serial_work, pl_u32 span_ceiling,
    pl_u32 *out);
int pl_x86_candidates_select_under(
    const pl_x86_native_candidates *candidates,
    pl_u32 serial_span, pl_u32 serial_work,
    pl_u32 span_ceiling, pl_u32 work_ceiling,
    pl_x86_native_selection *out);
int pl_x86_candidates_select_joint_minimum(
    const pl_x86_native_candidates *candidates,
    pl_u32 serial_span, pl_u32 serial_work,
    pl_x86_native_selection *out,
    pl_u32 *minimum_span, pl_u32 *minimum_work);

/* Return the exact non-dominated (span,work) frontier.  Equal cost points
 * retain only their shortest exact x86 spelling.  This is a failure-side
 * diagnostic when the componentwise minima have no joint witness; it must
 * not be replaced by the first K enumerated productions. */
int pl_x86_candidates_pareto_frontier(
    const pl_x86_native_candidates *candidates,
    pl_u32 serial_span, pl_u32 serial_work,
    pl_x86_native_selection *out, pl_u32 capacity, pl_u32 *count);

/* Select ordinary x86 from one normalized block.  Node-free GPR frames,
 * flag-free affine additions and architectural ALU nodes emit canonical x86
 * directly.  The shortest equivalent source suffix remains a competing
 * spelling while the direct grammar expands, never an interpreter route.
 * Direct PC-relative control retains an explicit layout fixup, so a stale
 * displacement is never emitted. */
int pl_x86_select_measure(const pl_x86_frontend *frontend,
                          const pl_x86_block_workspace *workspace,
                          const pl_x86_block *block,
                          pl_x86_native_selection *out);

int pl_x86_select_write(const pl_x86_frontend *frontend,
                        const pl_x86_block_workspace *workspace,
                        const pl_x86_block *block,
                        pl_u8 *output, pl_u32 output_capacity,
                        pl_u32 *output_bytes,
                        pl_x86_native_selection *selection);

/* Write one already-selected frontier member.  Layout uses this after the
 * release-wide physical ceilings have chosen the member; it must not rerun a
 * local selector and silently choose a different spelling. */
int pl_x86_select_write_measured(
    const pl_x86_frontend *frontend, const pl_x86_block *block,
    const pl_x86_native_selection *selection,
    pl_u8 *output, pl_u32 output_capacity, pl_u32 *output_bytes);

/* Bind one selected relative field after layout maps its source target to an
 * output virtual address.  The compiler never retains this workspace record
 * in the resulting ELF. */
int pl_x86_select_bind_fixup(pl_u8 *output, pl_u32 output_bytes,
                            const pl_x86_native_selection *selection,
                            pl_u32 fixup_index, pl_u64 output_address,
                            pl_u64 target_address);

#endif /* POSTLINK_SELECT_X86_H */
