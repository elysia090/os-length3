/* Fixed-coordinate erasure rows; reconstruction precedes authentication. */

#ifndef STORAGE_ERASURE_H
#define STORAGE_ERASURE_H

#include <support/types.h>

typedef struct {
    pl_u16 data_shards;
    pl_u16 parity_shards;
    pl_u32 shard_bytes;
} storage_erasure_shape;

int storage_erasure_shape_validate(const storage_erasure_shape *shape);

#endif /* STORAGE_ERASURE_H */
