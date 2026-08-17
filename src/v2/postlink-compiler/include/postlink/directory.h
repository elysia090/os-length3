/* Block admission by rank, without assembling a record.
 *
 * The delivered artifact already holds every part of a block exactly once:
 * shared SSA templates, per-instance parameter rows, deduplicated code proofs
 * and shared continuation residuals. Concatenating those back into one X86B
 * record per block undoes the quotient -- the measured cost is 15.3 MB of
 * stored STEP re-expanding to 70.9 MB of record payload.
 *
 * So admission here resolves a RIP to *coordinates* into the mapped regions
 * and never copies a byte. The runtime reads the three extents in place.
 *
 * Freestanding: no libc, no allocation. The caller owns the mapped bytes.
 */

#ifndef POSTLINK_DIRECTORY_H
#define POSTLINK_DIRECTORY_H

#include <postlink/continuation.h>
#include <postlink/machine.h>

/* Row widths in the descriptor region. */
#define PL_BLOCK_INSTANCE_BYTES 20u   /* rip u64, step/continuation/guard u32 */
#define PL_STEP_INSTANCE_BYTES  16u   /* template rank, param offset/length,
                                       * instantiated step extent */
#define PL_EXTENT_BYTES          8u   /* offset u32, length u32 */
#define PL_CONTINUATION_OFFSET_BYTES 4u

/* Counts, taken from the container header. */
typedef struct {
    pl_u32 schema;          /* 5 or 6; 6 continuations carry a chain */
    pl_u32 block_count;
    pl_u32 step_count;
    pl_u32 template_count;
    pl_u32 guard_count;
    pl_u32 continuation_count;
    pl_u32 continuation_bytes;
    pl_u32 template_execution_bytes;
    pl_u32 parameter_execution_bytes;
    pl_u32 execution_bytes;
} pl_directory_counts;

typedef struct {
    const pl_u8 *descriptors;
    pl_u64 descriptor_bytes;
    pl_directory_counts counts;
    /* Derived section bases inside the descriptor region. */
    pl_u32 instance_base;
    pl_u32 template_base;
    pl_u32 guard_base;
    pl_u32 continuation_offset_base;
    pl_u32 continuation_payload_base;
} pl_directory;

typedef struct {
    pl_u64 rip;
    pl_u32 step_rank;
    pl_u32 continuation_rank;
    pl_u32 guard_rank;
} pl_block_instance;

/* Everything the runtime needs to execute one block, as coordinates into the
 * execution region. No bytes are copied and no record exists. */
typedef struct {
    pl_u64 rip;
    pl_region guard;        /* exact executable proof */
    pl_region parameters;   /* typed parameter row for this instance */
    pl_region tmpl;         /* shared normalized SSA template */
    pl_u32 step_bytes;      /* extent of the STEP once projected */
    pl_u32 template_rank;   /* the quotient class this block belongs to */
    int chainable;          /* schema 6: the dispatch is folded */
    pl_u32 chain_index;     /* schema 6: the successor block row */
    pl_continuation continuation;   /* absolute, RIP already applied */
} pl_admission;

#define PL_ERROR_DIRECTORY (-12)
#define PL_ERROR_RANK      (-13)
#define PL_ERROR_ABSENT    (-14)

/* Validate the descriptor region against the header counts and derive the
 * section bases. The extents of every section are fully determined by the
 * counts, so a descriptor region that does not tile exactly is rejected. */
int pl_directory_open(const pl_u8 *descriptors, pl_u64 descriptor_bytes,
                      const pl_directory_counts *counts, pl_directory *out);

/* Read one block instance row. */
int pl_directory_block(const pl_directory *directory, pl_u32 index,
                       pl_block_instance *out);

/* Locate the first block instance at `rip`. Rows are sorted by RIP, so this
 * is a binary search; `variants` reports how many rows share the coordinate,
 * which is how a stronger proof shadows a weaker one at the same address.
 * Returns PL_ERROR_ABSENT when the coordinate has no block. */
int pl_directory_find(const pl_directory *directory, pl_u64 rip,
                      pl_u32 *index, pl_u32 *variants);

/* Resolve one block instance to its execution-region coordinates. */
int pl_directory_admit(const pl_directory *directory, pl_u32 index,
                       pl_admission *out);

#endif /* POSTLINK_DIRECTORY_H */
