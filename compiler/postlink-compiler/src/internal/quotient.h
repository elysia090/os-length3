/* Complete-future reductions over finite machine cuts.
 *
 * This layer knows no x86, Wasm, storage codec, or serialized row format.  It
 * proves when an infinite Byte* history has a finite direct coordinate before
 * any physical representation is selected.
 */

#ifndef POSTLINK_QUOTIENT_H
#define POSTLINK_QUOTIENT_H

#include "format.h"
#include <support/future.h>

#define PL_FUTURE_BYTE_ALPHABET 256u
#define PL_FUTURE_ABSENT 0xffffffffu

#define PL_ERROR_FUTURE_LAW   (-86)
#define PL_ERROR_FUTURE_CSR   (-87)

typedef struct {
    pl_u32 state_count;
    pl_u32 initial;
    const pl_u64 *outputs;
    /* Row-major [state_count][256], total over every declared state. */
    const pl_u32 *transitions;
} pl_byte_future_machine;

typedef struct {
    /* `state_class` has state_count entries.  Unreachable entries become
     * PL_FUTURE_ABSENT. `class_outputs` has state_count entries and
     * `byte_classes` has exactly 256. */
    pl_u32 *state_class;
    pl_u64 *class_outputs;
    pl_u32 *byte_classes;
    pl_u32 state_capacity;
} pl_byte_future_workspace;

typedef struct {
    pl_u32 reachable_states;
    pl_u32 classes;
    pl_u32 initial_class;
    pl_u64 checked_transitions;
    pl_u32 retained_transition_cells;
} pl_byte_future_projection;

/* Cost-preserving complete-future quotient.
 *
 * `observation` is the immediate architectural/barrier observation.
 * `residual_work` is the exact irreducible operation count on an arm after
 * dead work, substitutions, and any real common-prefix extraction.  A
 * compiler must not subtract work merely to make two rows compare equal.
 *
 * `frontier` is a canonical rank of the complete live-output dependency
 * height vector on that arm.  A scalar maximum span is not sufficient here:
 * different height vectors compose differently with a later slice.  Source
 * node ids, wave ids, constants, and addresses must already have left this
 * rank; dense physical-SSA topology and its live output coordinates remain.
 *
 * Two states are merged exactly when these immediate weighted observations
 * agree on every arm and their successor states have the same complete
 * future.  Thus semantic equality cannot erase different physical work or a
 * different compositional dependency frontier.  Common executable prefixes
 * may be moved to incoming edges before this operation; their actual code and
 * cost remain on those edges.
 */
typedef struct {
    pl_u32 states;
    pl_u32 observation_classes;
    pl_u32 arms;
    pl_u32 frontier_classes;
    const pl_u32 *observation;
    const pl_u32 *successor;      /* row-major [states][arms], total */
    const pl_u64 *residual_work;  /* row-major [states][arms] */
    const pl_u32 *frontier;       /* row-major [states][arms] */
} pl_weighted_future_machine;

typedef struct {
    /* All three state vectors have `state_capacity` entries.  `state_class`
     * is the result; the other two are build-only radix/order columns.
     * `immediate_class` may alias the machine observation column: projection
     * keeps the complete weighted tuple immutable through the last comparison
     * and replaces that dead column only afterwards. */
    pl_u32 *state_class;
    pl_u32 *order;
    pl_u32 *immediate_class;
    pl_u32 state_capacity;
    pl_u8 *scratch;
    pl_u32 scratch_bytes;
} pl_weighted_future_workspace;

typedef struct {
    pl_u32 immediate_classes;
    pl_finite_future_projection future;
} pl_weighted_future_projection;

int pl_weighted_future_workspace_measure(pl_u32 states, pl_u32 arms,
                                         pl_u32 *bytes);
int pl_weighted_future_project(
    const pl_weighted_future_machine *machine,
    const pl_weighted_future_workspace *workspace,
    pl_weighted_future_projection *out);

enum pl_future_reduce_kind {
    PL_FUTURE_REDUCE_NONE = 0,
    PL_FUTURE_REDUCE_MIN_U64 = 1,
    PL_FUTURE_REDUCE_MAX_U64 = 2,
    PL_FUTURE_REDUCE_ADD_U64 = 3,
    PL_FUTURE_REDUCE_OR_U64 = 4,
};

/* Normal form for a nonempty CSR record over a right-zero Byte* quotient.
 * The endpoint selects one byte, and that byte directly selects one of 256
 * value coordinates.  No history state or transition row remains. */
typedef struct {
    pl_u64 records;
    pl_u64 data_bytes;
    pl_u64 checked_offsets;
    pl_u32 address_bits;
    pl_u32 value_slots;
    pl_u32 retained_transition_cells;
    pl_u32 retained_root_slots;
    pl_u32 retained_presence_planes;
    pl_u32 reduce_kind;
} pl_byte_csr_projection;

/* Prove the right-zero law on every reachable state and all 256 bytes:
 *
 *     delta(q, b) = h(b).
 *
 * The empty history reaches `initial`; every nonempty history reaches h(last).
 * Since all later nonempty futures are state-independent, two reachable cuts
 * have the same complete future iff their current Moore outputs are equal.
 * The result therefore supplies both a finite upper bound and the matching
 * distinction lower bound without retaining a transition row. */
int pl_byte_future_project(const pl_byte_future_machine *machine,
                           const pl_byte_future_workspace *workspace,
                           pl_byte_future_projection *out);

/* Prove offsets[0] = 0, offsets[i] < offsets[i+1], and
 * offsets[records] = data_size.  Substitution then gives the complete lookup
 *
 *     values[data[offsets[record + 1] - 1]].
 *
 * A supported reduction kind supplies an identity value, so absence is that
 * value and a separate presence plane is not retained. */
int pl_byte_csr_project(const pl_byte_future_projection *future,
                        const pl_u64 *offsets,
                        pl_u64 records,
                        pl_u64 data_size,
                        pl_u32 reduce_kind,
                        pl_byte_csr_projection *out);

#endif /* POSTLINK_QUOTIENT_H */
