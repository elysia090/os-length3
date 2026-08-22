/* Exact residual-state partition of the native block graph.
 *
 * Hashes only locate candidate rows.  Every merge compares the complete
 * signature, so a collision cannot change the quotient.  Storage belongs to
 * the caller and the implementation is freestanding.
 */

#ifndef POSTLINK_DISPATCH_H
#define POSTLINK_DISPATCH_H

#include <postlink/chain.h>

#define PL_DISPATCH_GOTO (PL_CONTROL_MAX + 1u)

enum pl_dispatch_target_kind {
    PL_DISPATCH_TARGET_NONE = 0,
    PL_DISPATCH_TARGET_CLASS = 1,
    PL_DISPATCH_TARGET_ABSENT = 2,
    PL_DISPATCH_TARGET_VARIANTS = 3
};

typedef struct {
    pl_u32 kind;
    pl_u32 class_rank;
    pl_u32 variants;
    pl_u64 coordinate;
} pl_dispatch_target;

typedef struct {
    pl_u32 step_rank;
    pl_u32 control;
    pl_u64 payload[3];
    pl_dispatch_target successor[PL_MAX_SUCCESSORS];
} pl_dispatch_signature;

typedef struct {
    pl_u32 classes;
    pl_u32 conditionals;
    pl_u32 collapsed_conditionals;
    pl_u32 complemented_conditionals;
    pl_u32 absent_targets;
    pl_u32 variant_targets;
    pl_u32 maximum_probe;
} pl_dispatch_report;

/* Derive one block's signature after substituting the previous partition's
 * ranks for every uniquely resolved static successor.  `prior_class` may be
 * null for the coarsest partition. */
int pl_dispatch_describe(const pl_directory *directory, pl_u32 index,
                         const pl_u32 *prior_class,
                         pl_dispatch_signature *out,
                         pl_dispatch_report *report);

int pl_dispatch_signature_equal(const pl_dispatch_signature *left,
                                const pl_dispatch_signature *right);

/* One exact refinement round. `table_slots` must be a power of two and at
 * least twice block_count.  `table` is cleared by the function. */
int pl_dispatch_refine(const pl_directory *directory,
                       const pl_u32 *prior_class, pl_u32 *next_class,
                       pl_dispatch_signature *signature,
                       pl_u32 *table, pl_u32 table_slots,
                       pl_dispatch_report *report);

#endif /* POSTLINK_DISPATCH_H */
