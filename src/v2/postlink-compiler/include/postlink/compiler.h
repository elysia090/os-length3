/* Standalone linked-x86 to optimized-x86 compiler contract.
 *
 * The compiler owns no execution or publication policy.  A
 * successful call emits one ordinary x86-64 ET_EXEC/ET_DYN ELF.  Its proof is
 * represented with standard ELF symbols and a GNU build-id and is accepted by
 * optimized-x86/reader.h.  Unsupported semantics, incomplete closure, or a
 * non-improving cost is a compile error; there is no runtime fallback.
 */

#ifndef POSTLINK_COMPILER_H
#define POSTLINK_COMPILER_H

#include <support/types.h>

#define POSTLINK_NO_INSTRUCTION 0xffffffffu
#define POSTLINK_PARETO_DIAGNOSTIC_LIMIT 9u

enum postlink_status {
    POSTLINK_OK = 0,
    POSTLINK_ERROR_ARGUMENT = -100,
    POSTLINK_ERROR_INPUT_ELF = -101,
    POSTLINK_ERROR_WORKSPACE = -102,
    POSTLINK_ERROR_SEMANTICS = -103,
    POSTLINK_ERROR_CLOSURE = -104,
    POSTLINK_ERROR_EMIT = -105,
    POSTLINK_ERROR_PROOF = -106,
    POSTLINK_ERROR_NOT_SMALLER = -107,
    POSTLINK_ERROR_NOT_FASTER = -108,
    POSTLINK_ERROR_INCOMPLETE = -109,
    POSTLINK_ERROR_RELOCATIONS = -110,
    POSTLINK_ERROR_RELOCATION_CLOSURE = -111
};

typedef struct {
    pl_u64 input_bytes;
    pl_u64 output_bytes;
    /* The structural measure is intentionally decode-free.  If the exact
     * closed block population needs more transient space than that first
     * bound, compile returns POSTLINK_ERROR_WORKSPACE with this larger exact
     * requirement.  Retrying with that extent is the same compilation; no
     * graph or sidecar becomes part of the output ELF. */
    pl_u64 required_workspace_bytes;
    pl_u64 executable_coordinates;
    pl_u64 direct_coordinates;
    pl_u64 fault_coordinates;
    pl_u64 unclosed_coordinates;
    pl_u64 first_unclosed_coordinate;
    pl_u64 input_work;
    pl_u64 output_work;
    pl_u64 input_span;
    pl_u64 output_span;
    pl_u64 input_code_bytes;
    pl_u64 output_code_bytes;
    pl_u64 construction_relocations;
    pl_u64 reachable_source_bytes;
    pl_u64 native_source_instructions;
    pl_u64 native_source_work;
    pl_u64 native_normalized_work;
    pl_u64 native_source_span;
    pl_u64 native_normalized_span;
    pl_u64 native_selected_source_bytes;
    pl_u64 native_selected_output_bytes;
    pl_u64 native_eliminated_bytes;
    /* Exact partition of selected blocks.  `copied_source` means the native
     * body retained a source x86 suffix instead of emitting the normalized
     * physical SSA.  `normalization_escape` is the strict subset for which
     * the normalizer produced fewer physical nodes but selection retained the
     * whole source instruction population.  Its work field is the plan-node
     * delta, not a claimed native lower bound: terminal control and final
     * architectural materialization still have to be selected. */
    pl_u64 native_direct_frame_source_bytes;
    pl_u64 native_direct_frame_output_bytes;
    pl_u64 native_copied_source_source_bytes;
    pl_u64 native_copied_source_output_bytes;
    pl_u64 native_erased_source_bytes;
    pl_u64 native_omitted_prefix_bytes;
    pl_u64 native_normalization_escape_source_bytes;
    pl_u64 native_normalization_escape_output_bytes;
    pl_u64 native_normalization_escape_work;
    pl_u64 native_first_normalization_escape_address;
    pl_u64 native_emitted_instructions;
    pl_u64 relocation_records;
    pl_u64 relocated_code_fields;
    pl_u64 relocated_runtime_fields;
    pl_u64 rewritten_relocation_fields;
    pl_u64 rewritten_dynamic_addends;
    pl_u64 rewritten_dynamic_symbols;
    pl_u64 rewritten_dynamic_code_pointers;
    pl_u64 rewritten_lazy_binding_code_pointers;
    pl_u64 rewritten_unwind_rows;
    pl_u64 rewritten_unwind_ranges;
    pl_u64 unresolved_relocations;
    pl_u64 first_unresolved_relocation_offset;
    pl_u64 metadata_failure_field;
    pl_u64 metadata_failure_target;
    pl_u64 projection_source;
    pl_u64 projection_source_end;
    pl_u64 projection_block_start;
    pl_u64 projection_block_end;
    pl_u64 projection_omitted_end;
    pl_u64 native_failure_address;
    pl_u64 native_failure_end;
    pl_u64 native_failure_target;
    pl_u64 native_failure_output;
    pl_u64 native_failure_expected;
    pl_u64 native_first_pareto_address;
    pl_i32 native_failure_status;
    pl_u32 native_failure_live_outputs;
    pl_u64 native_first_nonimage_control_target;
    pl_u64 native_overlapping_source_address;
    pl_u64 native_overlapping_source_end;
    pl_u64 native_first_overlapping_address;
    pl_u32 entry_candidates;
    pl_u32 native_entries;
    pl_u32 native_observable_entries;
    pl_u32 code_grid_candidates;
    pl_u32 native_code_grids;
    pl_u32 native_blocks;
    pl_u32 native_observation_classes;
    pl_u32 native_future_classes;
    pl_u32 native_future_shared_blocks;
    pl_u32 native_observable_future_classes;
    pl_u32 native_minimum_entry_coordinates;
    pl_u32 native_shareable_entry_blocks;
    pl_u32 native_selected_blocks;
    pl_u32 native_unselected_blocks;
    pl_u32 native_direct_frame_blocks;
    pl_u32 native_copied_source_blocks;
    pl_u32 native_erased_blocks;
    pl_u32 native_normalization_escape_blocks;
    pl_u32 native_dynamic_blocks;
    pl_u32 native_rflags_dead_blocks;
    pl_u32 native_rflags_projected_blocks;
    pl_u32 native_rflags_projection_grammar_blocks;
    pl_u32 native_rflags_projection_grew_blocks;
    pl_u32 native_rflags_projection_escape_blocks;
    pl_u32 native_rflags_projection_source_identity_blocks;
    pl_u32 native_rflags_projection_changed_grammar_blocks;
    pl_u64 native_first_rflags_projection_grammar_address;
    pl_u64 native_first_rflags_projection_grew_address;
    pl_u64 native_first_rflags_projection_escape_address;
    pl_u64 native_first_rflags_projection_changed_grammar_address;
    pl_u32 native_pareto_unresolved_blocks;
    pl_u32 native_pareto_frontier_count;
    pl_u32 native_pareto_span[POSTLINK_PARETO_DIAGNOSTIC_LIMIT];
    pl_u32 native_pareto_work[POSTLINK_PARETO_DIAGNOSTIC_LIMIT];
    pl_u32 native_pareto_bytes[POSTLINK_PARETO_DIAGNOSTIC_LIMIT];
    pl_u32 native_nonimage_control_edges;
    pl_u32 dispatch_base_candidates;
    pl_u32 dispatch_bases;
    pl_u32 dispatch_targets;
    pl_u32 input_sections;
    pl_u32 executable_sections;
    pl_u32 relocated_executable_sections;
    pl_u32 first_unresolved_relocation_type;
    pl_u32 first_unresolved_relocation_stage;
    pl_u32 metadata_failure_kind;
    pl_u32 metadata_failure_stage;
    pl_u32 native_failure_stage;
    pl_u32 proof_stage;
} postlink_report;

typedef struct {
    pl_u64 output_capacity;
    pl_u64 workspace_bytes;
    pl_u32 workspace_alignment;
} postlink_measurement;

/* Optional build-side stream consumed by the release publisher during the
 * same compilation that emits the ordinary optimized ELF.  Every pointer is
 * valid only for the duration of its callback.  The observer copies what it
 * needs into its release-wide population; nothing below becomes an ELF
 * sidecar or a second compiler output format. */
typedef struct {
    void *context;
    int (*begin)(void *context, pl_u32 states, pl_u32 arms,
                 pl_u64 source_instructions);
    /* One canonical residual-instruction law after all source functions,
     * files, decoded instructions, SSA topology and bindings have been
     * composed.  The X86N5 cell contains the exact transfer factored into a
     * canonical SSA law and exact binding row, independently
     * proved work-star and span-star, their joint-witness bit, and the live dependency-
     * frontier transform. `successor` is the only adjacent
     * relation and has the `arms` length supplied to begin(). Both pointers
     * are transient borrowed storage. */
    int (*block)(
        void *context, pl_u32 state,
        const pl_u8 *instruction, pl_u32 instruction_bytes,
        const pl_u32 successor[2]);
    /* Final file-coordinate projection of each state body, after relocation
     * and proof sealing.  State order is the same dense order passed to
     * block().  Empty emitted bodies have byte_count zero. */
    int (*emitted)(
        void *context, pl_u32 state, pl_u64 file_offset,
        const pl_u8 *bytes, pl_u32 byte_count);
    /* Called only after the ordinary ELF has passed its final reader/proof
     * gate.  Returning nonzero rejects both the compile and the observation
     * transaction. */
    int (*commit)(void *context,
                  const pl_u8 *optimized_elf, pl_u64 optimized_elf_bytes);
} postlink_observer;

/* Measure a safe ordinary-ELF output capacity and the decode-free first
 * workspace bound.  Measurement reads ELF structure and entry population but
 * deliberately does not decode executable coordinates; the following
 * compile call owns the semantic closure pass.  A dense closed block graph
 * can request one exact larger workspace through required_workspace_bytes.
 * Exact emitted bytes are returned by the writer after native instruction
 * selection; output_capacity is not a predicted compression result. */
int postlink_measure(const pl_u8 *input, pl_u64 input_bytes,
                     postlink_measurement *measurement,
                     postlink_report *report);

/* Compile into caller-owned storage. output_bytes receives the exact ELF
 * extent. Success implies the output is independently accepted by
 * ox_image_open, is smaller than the input, and does not regress the declared
 * static work/span/code cost. Native speed is a separate paired benchmark. */
int postlink_compile(const pl_u8 *input, pl_u64 input_bytes,
                     pl_u8 *output, pl_u64 output_capacity,
                     pl_u64 *output_bytes,
                     pl_u8 *workspace, pl_u64 workspace_bytes,
                     postlink_report *report);

/* Identical product compilation with one transient complete-population
 * observer.  A nonzero callback result rejects the compilation. */
int postlink_compile_observed(
    const pl_u8 *input, pl_u64 input_bytes,
    pl_u8 *output, pl_u64 output_capacity, pl_u64 *output_bytes,
    pl_u8 *workspace, pl_u64 workspace_bytes,
    const postlink_observer *observer, postlink_report *report);

const char *postlink_status_string(int status);

#endif /* POSTLINK_COMPILER_H */
