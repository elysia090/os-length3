/* One release-wide quotient of canonical residual x86 instructions. */

#ifndef ARTIFACT_PROGRAM_H
#define ARTIFACT_PROGRAM_H

#include <artifact/derive.h>
#include <artifact/future.h>

#define ARTIFACT_ERROR_PROGRAM       (-85)
#define ARTIFACT_ERROR_PROGRAM_RANGE (-86)

typedef struct {
    /* One already-normalized immediate residual instruction per reachable
     * cut. The cell is the single canonical law selected by the compiler:
     * architectural transfer, exact bindings, ordered observation, exact
     * work/span and live dependency-frontier transformation. Source file,
     * function, decoded block, SSA node, topology and parameter families are
     * absent. They are construction coordinates, never artifact owners. */
    const artifact_cell *instruction; /* states */

    /* Total ordered future over the disjoint union of every linked input in
     * the release. A coordinate is build scratch; only the stabilized class
     * relation is program identity. */
    const pl_u32 *successor;           /* states * arms */
    pl_u32 states;
    pl_u32 arms;
} artifact_program_population;

typedef struct {
    artifact_future_workspace future;
} artifact_program_workspace;

typedef struct {
    artifact_future_projection future;
    pl_u64 opened_instruction_bytes;
    pl_u64 retained_instruction_bytes;
    pl_u32 instruction_occurrences;
    pl_u32 instruction_classes;
    pl_u32 shared_instruction_occurrences;
    /* Every X86N5 cell carries independent work/span lower bounds. A joint
     * witness has flag 7; a nonjoint Pareto selection has flag 3 and stores
     * its actual costs separately. Its live frontier is derived from the law
     * and is never stored as a second state row. */
    pl_u32 minimum_proof_occurrences;
    pl_u32 joint_witness_occurrences;
    pl_u64 work_lower_bound_sum;
    pl_u64 span_lower_bound_sum;
    pl_u64 maximum_work_lower_bound;
    pl_u64 maximum_span_lower_bound;
    /* Successors are reopened only to prove closure and complete-future
     * equivalence. Direct control in the accepted optimized ELF is the sole
     * executable owner; no residual state row or edge row is emitted. */
    pl_u64 checked_successor_coordinates;
    pl_u32 retained_residual_state_rows;
    pl_u32 retained_residual_edge_rows;
} artifact_program_projection;

/* Necessary-and-sufficient finite construction:
 *
 *   sig_0(q)     = instruction(q)
 *   sig_(n+1)(q) = (instruction(q),
 *                   class_n(successor(q,a)) for every ordered arm a)
 *
 * Stabilization is the complete-future quotient. Equality is sufficient by
 * induction on finite arm words. It is necessary because a differing
 * instruction is an immediate distinguisher and a differing successor class
 * has a finite distinguishing suffix. Canonical signature order removes the
 * remaining class-renaming freedom.
 *
 * This routine projects proof scratch only. It emits no component table,
 * future row, topology dictionary, parameter stream or X86N cell. The sole
 * retained program owner is the independently runnable optimized ELF emitted
 * by the compiler. */
int artifact_program_project(
    const artifact_program_population *population,
    const artifact_program_workspace *workspace,
    artifact_program_projection *out);

#endif /* ARTIFACT_PROGRAM_H */
