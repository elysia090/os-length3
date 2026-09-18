/* Typed object selected from an authenticated artifact index. */

#ifndef ARTIFACT_RESOURCE_H
#define ARTIFACT_RESOURCE_H

#include <artifact/index.h>
#include <artifact/object.h>

enum artifact_resource_kind {
    ARTIFACT_RESOURCE_NONE = 0,
    ARTIFACT_RESOURCE_WASM_MODULE,
    ARTIFACT_RESOURCE_MEMORY_PAGE,
    ARTIFACT_RESOURCE_DIRECTORY,
    ARTIFACT_RESOURCE_BOOT_SNAPSHOT,
};

typedef struct {
    pl_index_key key;
    artifact_object object;
    pl_u64 coordinate;
    pl_u64 generation;
} artifact_resource;

int artifact_resource_validate(const artifact_resource *resource);

#endif /* ARTIFACT_RESOURCE_H */
