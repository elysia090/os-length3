#include <storage/erasure.h>

int storage_erasure_shape_validate(const storage_erasure_shape *shape)
{
    return shape && shape->data_shards && shape->parity_shards
        && shape->shard_bytes
        && (pl_u32)shape->data_shards + shape->parity_shards <= 256u;
}
