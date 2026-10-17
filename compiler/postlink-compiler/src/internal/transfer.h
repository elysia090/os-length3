/* Conservative linked-x86 transfer classes.
 *
 * This is a build-side quotient, not a runtime instruction table.  One dense
 * row retains only the hash and source coordinate of a representative.  A
 * hash hit is proved by decoding that representative again and comparing the
 * complete normalized transfer, so collisions cannot merge different code.
 * Absolute coordinates and terminal-fault source bytes remain in the separate
 * code proof; physical and virtual aliases of the same linked bytes and equal
 * architectural fault functions receive one rank.
 */

#ifndef POSTLINK_TRANSFER_H
#define POSTLINK_TRANSFER_H

#include <x86/decode.h>

#define PL_ERROR_TRANSFER          (-45)
#define PL_ERROR_TRANSFER_CAPACITY (-46)

typedef struct {
    pl_u64 hash;
    pl_u64 representative;
} pl_transfer_identity;

typedef struct {
    pl_x86_frontend frontend;
    pl_transfer_identity *identities;
    pl_u32 identity_capacity;
    pl_u32 identity_count;
    pl_u32 *hash_slots;       /* identity rank + 1; zero means empty */
    pl_u32 hash_slot_count;
    pl_u64 admissions;
    pl_u64 shared;
    pl_u64 probes;
    pl_u32 maximum_probe;
} pl_transfer_builder;

/* hash_slot_count must be a power of two and exceed identity_capacity.  The
 * caller can use a larger table to trade temporary build memory for probes.
 * Neither identities nor hash_slots is published in the executable. */
int pl_transfer_builder_open(pl_transfer_builder *builder,
                             const pl_x86_image *image,
                             pl_transfer_identity *identities,
                             pl_u32 identity_capacity,
                             pl_u32 *hash_slots,
                             pl_u32 hash_slot_count);

/* Return a dense, collision-proved rank.  The source image must remain
 * immutable for the lifetime of the builder. */
int pl_transfer_intern(pl_transfer_builder *builder,
                       const pl_x86_instruction *instruction,
                       pl_u32 *rank);

/* Adapter for pl_closure_build: every total page coordinate is mapped to its
 * conservative class before SSA/QM may merge stronger semantic equivalents. */
int pl_transfer_rank_instruction(const pl_x86_instruction *instruction,
                                 void *context, pl_u32 *rank);

#endif /* POSTLINK_TRANSFER_H */
