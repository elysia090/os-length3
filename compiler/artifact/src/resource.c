#include <artifact/resource.h>
#include <support/checked.h>

int artifact_resource_validate(const artifact_resource *resource)
{
    return resource && resource->generation
        && resource->object.kind > ARTIFACT_RESOURCE_NONE
        && resource->object.kind <= ARTIFACT_RESOURCE_IMAGE_SOURCE
        && (resource->object.kind!=ARTIFACT_RESOURCE_IMAGE_MODULE || resource->coordinate>resource->key.minor)
        && resource->object.version == ARTIFACT_RESOURCE_VERSION
        && artifact_object_validate(&resource->object);
}

int artifact_resource_read(const pl_u8 row[ARTIFACT_RESOURCE_BYTES],
                            artifact_resource *resource)
{
    if (!row || !resource) return PL_ERROR_INDEX;
    artifact_resource value = {0};
    value.key = (pl_index_key){pl_read_u64(row),pl_read_u64(row+8u)};
    for (pl_u32 i=0u;i<PL_SHA256_BYTES;++i) value.object.digest[i]=row[16u+i];
    value.object.bytes=pl_read_u64(row+48u);
    value.object.kind=pl_read_u32(row+56u);value.object.version=pl_read_u32(row+60u);
    value.coordinate=pl_read_u64(row+64u);value.generation=pl_read_u64(row+72u);
    if (!artifact_resource_validate(&value)) return PL_ERROR_INDEX;
    *resource=value;return 0;
}

int artifact_resource_write(const artifact_resource *resource,
                             pl_u8 row[ARTIFACT_RESOURCE_BYTES])
{
    if (!row || !artifact_resource_validate(resource)) return PL_ERROR_INDEX;
    pl_write_u64(row,resource->key.major);pl_write_u64(row+8u,resource->key.minor);
    for (pl_u32 i=0u;i<PL_SHA256_BYTES;++i) row[16u+i]=resource->object.digest[i];
    pl_write_u64(row+48u,resource->object.bytes);
    pl_write_u32(row+56u,resource->object.kind);pl_write_u32(row+60u,resource->object.version);
    pl_write_u64(row+64u,resource->coordinate);pl_write_u64(row+72u,resource->generation);
    return 0;
}
