/* Build-side normalized-plan spelling; not an execution format. */
#ifndef POSTLINK_PLAN_CODEC_H
#define POSTLINK_PLAN_CODEC_H
#include <x86/ssa.h>
#include "template.h"

/* Decode one plan.  Unchanged local slots hold the identity operand for their
 * own slot, which is what makes substitution through them a no-op. */
int pl_plan_decode(const pl_u8 *tmpl, const pl_template *parsed,
                   const pl_u8 *row, pl_arena *arena, pl_plan *out);

/* Project one normalized plan into the compact operator template and typed
 * instance row consumed by pl_plan_decode.  Constants and frame coordinates
 * leave the template; node/projection edges and dependency waves remain. */
int pl_plan_template_measure(const pl_plan *plan, pl_u32 *template_bytes,
                             pl_u32 *parameter_bytes);
int pl_plan_template_write(const pl_plan *plan,
                           pl_u8 *template_target, pl_u32 template_capacity,
                           pl_u32 *template_written,
                           pl_u8 *parameter_target, pl_u32 parameter_capacity,
                           pl_u32 *parameter_written);

/* Release-wide pure-slice construction spelling.  Topology erases source
 * coordinates, instruction count, node names, dependency waves and every
 * lifted value.  The parameter spelling contains exactly those lifted values
 * and output coordinates.  Together they reconstruct the normalized plan;
 * separately they let equal DAG topology share across functions and ELFs. */
int pl_plan_topology_measure(const pl_plan *plan, pl_u32 *bytes);
int pl_plan_topology_write(const pl_plan *plan,
                           pl_u8 *target, pl_u32 capacity,
                           pl_u32 *written);
int pl_plan_parameters_measure(const pl_plan *plan, pl_u32 *bytes);
int pl_plan_parameters_write(const pl_plan *plan,
                             pl_u8 *target, pl_u32 capacity,
                             pl_u32 *written);


#endif /* POSTLINK_PLAN_CODEC_H */
