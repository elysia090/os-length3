/* Finite native block population for one linked x86 image. */

#ifndef POSTLINK_COMPILE_ELF_H
#define POSTLINK_COMPILE_ELF_H

#include <postlink/compiler.h>
#include "discover-entry.h"
#include "x86-selection.h"

#define PL_X86_NATIVE_OPERATION_COUNT 256u
#define PL_ERROR_NATIVE_PROJECT_ARGUMENT (-61)
#define PL_ERROR_NATIVE_PROJECT_BOUNDARY (-62)
#define PL_ERROR_NATIVE_PROJECT_FORM     (-63)
#define PL_ERROR_NATIVE_PROJECT_RANGE    (-64)
#define PL_ERROR_NATIVE_PROJECT_PARTIAL  (-65)
#define PL_ERROR_NATIVE_PROJECT_RESOLVE  (-66)
#define PL_ERROR_NATIVE_PROJECT_BEFORE   (-67)
#define PL_ERROR_NATIVE_PROJECT_END      (-68)
#define PL_ERROR_NATIVE_PROJECT_OMISSION (-69)
#define PL_ERROR_NATIVE_PROJECT_SYNTHETIC (-70)
#define PL_X86_NATIVE_PARETO_LIMIT PL_X86_NATIVE_MAX_CANDIDATES
/* Bound retained examples for exact whole-image diagnosis. This reporting
 * capacity does not limit compiler acceptance. */
#define PL_X86_NATIVE_ESCAPE_SAMPLE_COUNT 512u

typedef struct {
    pl_u64 start;
    pl_u64 end;
    pl_u32 live_output_mask;
    pl_u8 construction_fields;
    pl_u8 relax_short_control;
} pl_x86_native_escape_sample;

typedef struct {
    pl_u64 executable_coordinates;
    pl_u64 reachable_source_bytes;
    pl_u64 source_instructions;
    pl_u64 source_work;
    pl_u64 normalized_work;
    pl_u64 source_span;
    pl_u64 normalized_span;
    pl_u64 selected_source_bytes;
    pl_u64 selected_output_bytes;
    pl_u64 eliminated_bytes;
    pl_u64 direct_frame_source_bytes;
    pl_u64 direct_frame_output_bytes;
    pl_u64 copied_source_source_bytes;
    pl_u64 copied_source_output_bytes;
    pl_u64 erased_source_bytes;
    pl_u64 omitted_prefix_bytes;
    pl_u64 normalization_escape_source_bytes;
    pl_u64 normalization_escape_output_bytes;
    pl_u64 normalization_escape_work;
    pl_u64 first_normalization_escape_address;
    pl_x86_native_escape_sample
        normalization_escape_sample[PL_X86_NATIVE_ESCAPE_SAMPLE_COUNT];
    /* Static emitted instruction population is a layout diagnostic.  The
     * publication key uses the maxima below: one admitted block/event is one
     * physical cut, so unrelated bodies must never be added to its work or
     * span. */
    pl_u64 emitted_instructions;
    pl_u64 emitted_work;
    pl_u64 emitted_span;
    pl_u64 direct_instructions;
    pl_u64 fault_instructions;
    pl_u64 first_nonimage_control_target;
    pl_u64 first_overlapping_address;
    pl_u64 overlapping_source_address;
    pl_u64 overlapping_source_end;
    pl_u64 emit_failure_address;
    pl_u64 emit_failure_end;
    pl_u64 emit_failure_target;
    pl_u64 emit_failure_output;
    pl_u64 emit_failure_expected;
    pl_u32 emit_failure_live_outputs;
    pl_u64 maximum_work_address;
    pl_u64 maximum_span_address;
    pl_u32 boundaries;
    pl_u32 blocks;
    pl_u32 selected_blocks;
    pl_u32 unselected_blocks;
    pl_u32 direct_frame_blocks;
    pl_u32 copied_source_blocks;
    pl_u32 erased_blocks;
    pl_u32 normalization_escape_blocks;
    pl_u32 dynamic_blocks;
    pl_u32 rflags_dead_blocks;
    pl_u32 rflags_projected_blocks;
    pl_u32 rflags_projection_grammar_blocks;
    pl_u32 rflags_projection_grew_blocks;
    pl_u32 rflags_projection_escape_blocks;
    pl_u32 rflags_projection_source_identity_blocks;
    pl_u32 rflags_projection_changed_grammar_blocks;
    pl_u64 first_rflags_projection_grammar_address;
    pl_u64 first_rflags_projection_grew_address;
    pl_u64 first_rflags_projection_escape_address;
    pl_u64 first_rflags_projection_changed_grammar_address;
    pl_u32 nonimage_control_edges;
    pl_u32 metadata_boundary_targets;
    pl_u32 metadata_interior_targets;
    pl_u32 relaxation_candidates;
    pl_u32 relaxation_widened;
    pl_u32 relaxation_events;
    pl_u64 relaxation_rechecks;
    pl_u32 emit_failure_stage;
    int emit_failure_status;
    pl_u32 selection_span_ceiling;
    pl_u32 selection_work_ceiling;
    pl_u32 pareto_unresolved_blocks;
    pl_u32 pareto_frontier_count;
    pl_u64 first_pareto_address;
    pl_u32 pareto_span[PL_X86_NATIVE_PARETO_LIMIT];
    pl_u32 pareto_work[PL_X86_NATIVE_PARETO_LIMIT];
    pl_u32 pareto_bytes[PL_X86_NATIVE_PARETO_LIMIT];
    pl_u32 maximum_source_instructions;
    pl_u32 maximum_normalized_work;
    pl_u32 maximum_normalized_span;
    pl_u64 normalized_opcode[PL_OPCODE_COUNT];
    pl_u64 retained_source_operation[PL_X86_NATIVE_OPERATION_COUNT];
    pl_u32 select_reason[4];
    pl_u32 blocker_opcode[PL_OPCODE_COUNT];
} pl_x86_native_population;

typedef struct {
    pl_u32 blocks;
    pl_u32 observation_classes;
    pl_u32 future_classes;
    pl_u32 shared_blocks;
    pl_u32 observable_entries;
    pl_u32 observable_classes;
    pl_u32 minimum_entry_coordinates;
    pl_u32 shareable_entry_blocks;
    pl_u64 checked_successors;
    pl_u64 splitters;
    pl_u64 moved_blocks;
    /* Failure-only compiler diagnostics.  These fields live in caller
     * workspace and are never part of the optimized ELF or its proof. */
    pl_u64 failure_address;
    pl_u64 failure_target;
    pl_u64 required_bytes;
    pl_u64 available_bytes;
    int failure_status;
    pl_u32 failure_stage;
} pl_x86_native_future;

/* Ephemeral source-boundary to emitted-address function.  The boundary
 * bitset plus its 256-coordinate prefix ranks selects one compact offset per
 * admitted block; no u32 value is opened for every executable byte.  All
 * arrays are caller-owned compiler workspace and disappear after the ordinary
 * ELF has been written. */
typedef struct {
    const pl_x86_image *image;
    const pl_u8 *boundaries;
    const pl_u8 *construction_fields;
    const pl_u8 *fixed_coordinates;
    const pl_u8 *source_identity_coordinates;
    const pl_u8 *relaxed_control_coordinates;
    const pl_u32 *offset_by_boundary;
    const pl_u32 *rank_prefix;
    /* The same complete-future frontier used to emit each block.  Relocation
     * and metadata projection reform a block only to recover an exact source
     * field owner; they must not silently reopen the pre-projection frame. */
    const pl_u32 *live_outputs;
    pl_u32 coordinate_count;
    /* Only admitted boundaries own output offsets.  rank_prefix has one
     * cumulative count per 256 source coordinates plus its terminal count. */
    pl_u32 offset_count;
    pl_u32 rank_prefix_count;
    pl_u32 live_output_count;
    pl_u64 output_address;
    pl_u32 output_bytes;
    pl_u32 fixup_count;
    pl_u32 selection_span_ceiling;
    pl_u32 selection_work_ceiling;
    pl_x86_block_workspace formation;
    pl_x86_block_workspace selection;
} pl_x86_native_layout;

typedef struct {
    pl_u64 source_address;
    pl_u64 source_end;
    pl_u64 block_start;
    pl_u64 block_end;
    pl_u64 omitted_end;
    /* A synthesized construction field carries its canonical linked target;
     * relocation closure projects that target instead of replaying the
     * source expression which normalization erased. */
    pl_u64 synthetic_target;
    pl_u32 reason;
    pl_u32 synthetic_kind;
} pl_x86_native_projection;

#define PL_X86_NATIVE_PROJECTION_SOURCE_IDENTITY 1u
#define PL_X86_NATIVE_PROJECTION_SYNTHETIC_FIELD 2u
#define PL_X86_NATIVE_PROJECTION_RETAINED_INSTRUCTION 3u

/* The analysis retains boundary, expanded-boundary, instruction-start and
 * covered-byte bitsets plus one u32 work queue.  Expansion is distinct from
 * decoding: a later entry can split a previously decoded instruction stream
 * and must still publish the successors exposed by that cut.  The final two
 * bits distinguish metadata pointing at an instruction field from a true x86
 * entry without retaining decoded rows.  After discovery, those dead bits and
 * the unused queue suffix encode exact rel8 family-reselection deltas and
 * candidate coordinates.  One u32 per 256 coordinates plus a K/7-byte candidate
 * hierarchy turns
 * branch relaxation into an incremental monotone cut instead of rebuilding
 * the complete placement per widening round.  Fixed/source-identity projections
 * reuse dead discovery bitsets so relocation fields in a published terminal
 * tail resolve without a per-byte output-address array.  Block bodies use two fixed
 * alternating arenas and are discarded after their aggregate cost is
 * charged.  A second arena pair proves shorter source spellings against the
 * still-live normalized block; it is compiler workspace, never output. */
int pl_x86_native_workspace_measure(pl_u64 executable_coordinates,
                                    pl_u64 *workspace_bytes);

int pl_x86_native_analyze(const pl_x86_image *image,
                          const pl_elf_image *construction,
                          const pl_u64 *entries,
                          const pl_u8 *entry_roles,
                          pl_u32 primary_entry_count, pl_u32 entry_count,
                          pl_x86_code_grid *code_grids,
                          pl_u32 code_grid_capacity,
                          pl_u32 *code_grid_count,
                          pl_u8 *workspace, pl_u64 workspace_bytes,
                          pl_x86_native_population *out);

/* Reopen the admitted boundary population as one total two-arm machine.
 * Closed in-image successors are represented only by their state rank;
 * non-image targets remain part of the immediate observation.  The persistent
 * state vectors and the mutually exclusive observation/refinement phase have
 * separate extents so the latter can reuse the dead closure-queue tail. */
int pl_x86_native_future_workspace_measure(pl_u32 blocks,
                                            pl_u64 *persistent_bytes,
                                            pl_u64 *phase_bytes);

/* Compute the least complete-future architectural-output observation under
 * the x86-64 ABI, feed it back into block compaction, and rebuild the physical
 * placement. `live_outputs` is one 19-bit mask per admitted block and remains
 * compiler workspace only; it is recomputed from the graph, never published
 * as an artifact sidecar. */
int pl_x86_native_project_live_outputs(
    const pl_x86_image *image,
    pl_u8 *native_workspace, pl_u64 native_workspace_bytes,
    pl_x86_native_population *population,
    const pl_x86_code_grid *code_grids, pl_u32 code_grid_count,
    pl_u32 *live_outputs, pl_u32 live_output_capacity,
    pl_u8 *scratch, pl_u64 scratch_bytes);

int pl_x86_native_future_project(
    const pl_x86_image *image,
    pl_u8 *native_workspace, pl_u64 native_workspace_bytes,
    const pl_x86_native_population *population,
    const pl_x86_code_grid *code_grids, pl_u32 code_grid_count,
    const pl_u64 *entries, const pl_u8 *entry_roles, pl_u32 entry_count,
    const pl_u32 *live_outputs, pl_u32 live_output_count,
    pl_u8 *persistent_workspace, pl_u64 persistent_workspace_bytes,
    const postlink_observer *observer,
    pl_x86_native_future *out);

/* Emit the closed block population as one compact native code extent.  The
 * caller chooses its eventual virtual address; every direct-control and
 * RIP-relative field is rebound to that address before this call succeeds. */
int pl_x86_native_write(const pl_x86_image *image,
                        const pl_u64 *entries, pl_u32 entry_count,
                        pl_u64 output_address,
                        pl_u8 *output, pl_u32 output_capacity,
                        pl_u8 *workspace, pl_u64 workspace_bytes,
                        pl_x86_native_population *population,
                        pl_x86_native_layout *layout);

/* Emit directly from the boundary/offset physical arrays left by analyze.
 * This is the product path: it does not rediscover or reform the complete
 * finite closure merely because the output base has become known. */
int pl_x86_native_write_analyzed(
    const pl_x86_image *image, pl_u64 output_address,
    pl_u8 *output, pl_u32 output_capacity,
    const pl_x86_code_grid *code_grids, pl_u32 code_grid_count,
    const pl_u32 *live_outputs, pl_u32 live_output_count,
    pl_u8 *workspace, pl_u64 workspace_bytes,
    pl_x86_native_population *population,
    pl_x86_native_layout *layout);

/* Resolve a proved source boundary through the emitted layout. */
int pl_x86_native_resolve(const pl_x86_native_layout *layout,
                          pl_u64 source_address, pl_u64 *output_address);
int pl_x86_native_rank(const pl_x86_native_layout *layout,
                       pl_u64 source_address, pl_u32 *rank);

/* Resolve a retained source byte field, including bytes after an erased
 * identity prefix.  Construction relocations use this to patch their exact
 * field in the compact body.  ELF analysis marks such fields before selection
 * and retains a source-projectable spelling until a synthesized instruction
 * supplies an exact field map. */
int pl_x86_native_resolve_field(const pl_x86_native_layout *layout,
                                pl_u64 source_address,
                                pl_u64 *output_address);

/* Project an exact source field through native prefix elimination.  A proved
 * field can either be retained at output_address or be wholly absent because
 * its containing identity prefix was erased.  Partial overlap is invalid. */
int pl_x86_native_project_field(const pl_x86_native_layout *layout,
                                pl_u64 source_address, pl_u32 source_bytes,
                                pl_u64 *output_address, int *retained);
int pl_x86_native_project_field_diagnostic(
    const pl_x86_native_layout *layout,
    pl_u64 source_address, pl_u32 source_bytes,
    pl_u64 *output_address, int *retained,
    pl_x86_native_projection *projection);

/* Project a source instruction boundary (including the end of an erased
 * identity suffix) onto the compact output position. */
int pl_x86_native_project_boundary(const pl_x86_native_layout *layout,
                                   pl_u64 source_address,
                                   pl_u64 *output_address);

#endif /* POSTLINK_NATIVE_H */
